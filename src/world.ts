// Simulated external world. Sources publish observations; collectors read them with stable identity
// (a row's source_revision only changes when the source publishes again, 06 §6).
import { readFileSync } from 'node:fs';
import { canonicalize, sha256 } from './canonical.ts';
import type { Db } from './db.ts';
import type { Action, Observation, Policy, SourceClass } from './engine.ts';
import { deployPolicy } from './policy/deploy.ts';

const hashFiles = (...rel: string[]) => sha256(rel.map((r) => readFileSync(new URL(r, import.meta.url), 'utf8')).join('\u0000')).slice(0, 16);
/** Content hash of the evaluator itself: replay refuses to run under a different one. */
export const EVALUATOR_VERSION = `eval-${hashFiles('./engine.ts', './canonical.ts')}`;

export interface Domain {
  policy: Policy;
  policyHash: string;
  /** Server-resolved expected target versions + recovery scope, read from current state (06 §2). Null if unbindable. */
  bind: (db: Db, s: Scope, params: Record<string, any>) => { expectedTargetVersions: Action['expectedTargetVersions']; recoveryScope: Action['recoveryScope'] } | null;
  /** The single simulated side effect. Runs inside execute()'s transaction; SQL on `db` only. */
  apply: (db: Db, s: Scope, action: Action, now: number) => Record<string, unknown>;
}

export interface Scope { sessionId: string; runId: string }

export const DOMAINS: Record<string, Domain> = {
  deploy_release: {
    policy: deployPolicy,
    policyHash: `${deployPolicy.name}:${hashFiles('./policy/deploy.ts')}`,
    bind: (db, s, p) => {
      const st = readObs(db, s, 'deploy_state', 'deployer', { service: String(p.service), env: String(p.environment) });
      if (!st) return null;
      const v = st.value as Record<string, string | number>;
      return {
        expectedTargetVersions: { generation: v.generation, currentArtifact: v.currentArtifact, schemaVersion: v.schemaVersion, configVersion: v.configVersion },
        recoveryScope: { procedureHash: PROCEDURE_HASH },
      };
    },
    apply: (db, s, a, now) => {
      const p = a.params as Record<string, any>;
      const subject = { service: String(p.service), env: String(p.environment) };
      const st = readObs(db, s, 'deploy_state', 'deployer', subject);
      if (!st) throw new Error('deploy target vanished inside the execution transaction');
      const v = st.value as Record<string, any>;
      const next = { ...v, generation: v.generation + 1, currentArtifact: p.toArtifact, trafficPercent: p.trafficPercent };
      publish(db, s, { kind: 'deploy_state', sourceId: 'deployer', sourceClass: 'ADAPTER', subject, value: next }, now);
      return { effect: 'DEPLOYED', service: p.service, environment: p.environment, artifact: p.toArtifact, trafficPercent: p.trafficPercent, generation: next.generation };
    },
  },
};

export const PROCEDURE_HASH = 'rollback-procedure-v3';

const subjectKey = (subject: Record<string, unknown>) => sha256(canonicalize(subject));

export function publish(db: Db, s: Scope, o: { kind: string; sourceId: string; sourceClass: Exclude<SourceClass, 'HYPOTHETICAL'>; subject: Observation['subject']; value: Observation['value'] }, now: number, observedAt = now) {
  const key = subjectKey(o.subject);
  const prev = db.prepare('SELECT source_revision FROM world_obs WHERE session_id=? AND run_id=? AND kind=? AND source_id=? AND source_class=? AND subject_key=?')
    .get(s.sessionId, s.runId, o.kind, o.sourceId, o.sourceClass, key) as { source_revision: number } | undefined;
  db.prepare(`INSERT INTO world_obs VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id, run_id, kind, source_id, source_class, subject_key) DO UPDATE SET value_json=excluded.value_json, source_revision=excluded.source_revision, observed_at=excluded.observed_at`)
    .run(s.sessionId, s.runId, o.kind, o.sourceId, key, o.sourceClass, canonicalize(o.subject), canonicalize(o.value), (prev?.source_revision ?? 0) + 1, observedAt);
}

export function retract(db: Db, s: Scope, kind: string, sourceId?: string) {
  db.prepare(`DELETE FROM world_obs WHERE session_id=? AND run_id=? AND kind=? ${sourceId ? 'AND source_id=?' : ''}`)
    .run(...[s.sessionId, s.runId, kind, ...(sourceId ? [sourceId] : [])]);
}

type Row = { kind: string; source_id: string; source_class: SourceClass; subject_json: string; value_json: string; source_revision: number; observed_at: number };
const toObs = (r: Row): Observation => ({
  kind: r.kind, sourceId: r.source_id, sourceClass: r.source_class, sourceRevision: r.source_revision,
  subject: JSON.parse(r.subject_json), value: JSON.parse(r.value_json), observedAt: r.observed_at,
});

/** Collector: every observation currently published in this session's world (admission happens in the evaluator). */
export function collect(db: Db, s: Scope): Observation[] {
  return (db.prepare('SELECT kind, source_id, source_class, subject_json, value_json, source_revision, observed_at FROM world_obs WHERE session_id=? AND run_id=? ORDER BY kind, source_id, subject_key')
    .all(s.sessionId, s.runId) as Row[]).map(toObs);
}

export function readObs(db: Db, s: Scope, kind: string, sourceId: string, subject: Record<string, unknown>): Observation | null {
  const r = db.prepare('SELECT kind, source_id, source_class, subject_json, value_json, source_revision, observed_at FROM world_obs WHERE session_id=? AND run_id=? AND kind=? AND source_id=? AND source_class=? AND subject_key=?')
    .get(s.sessionId, s.runId, kind, sourceId, 'ADAPTER', subjectKey(subject)) as Row | undefined;
  return r ? toObs(r) : null;
}
