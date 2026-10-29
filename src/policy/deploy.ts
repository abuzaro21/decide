// deploy_release policy — 06 §9 v2.1, reduced policy deploy@cut1 (D-FREEZE / change_calendar cut, 13 §2).
import { approveGate, observationId as obsId, MIN, HOUR, type Ctx, type Policy, type Action } from '../engine.ts';
import { digest } from '../canonical.ts';

export const SERVICES: Record<string, { tier: 1 | 2 }> = { 'checkout-api': { tier: 1 }, 'search-api': { tier: 2 } };
const ENVS = ['dev', 'staging', 'prod'];
export const TELEMETRY_WINDOW_SEC = 300; // 06 §6: telemetry subject includes its 5-minute observation window

// Telemetry safety predicate (06 §6): strict, equality counts as unhealthy.
export const healthy = (v: Record<string, any>) => v.errorRatePct < 2.0 && v.p95Ms < 800;
const conflictBetween = (a: Record<string, any>, b: Record<string, any>) =>
  healthy(a) !== healthy(b) || Math.abs(a.errorRatePct - b.errorRatePct) > 1.0 || Math.abs(a.p95Ms - b.p95Ms) > 200;

const p = (a: Action) => a.params as Record<string, any>;
const drillSubject = (a: Action) => ({
  // `from` is the server-bound deployed artifact, never the requester's claim (G2-03).
  from: String(a.expectedTargetVersions.currentArtifact), to: String(p(a).toArtifact), env: String(p(a).environment),
  schemaVersion: a.expectedTargetVersions.schemaVersion, configVersion: a.expectedTargetVersions.configVersion,
  procedureHash: a.recoveryScope.procedureHash,
});

function telemetryConflict(c: Ctx) {
  const obs = c.admitted.telemetry;
  if (obs.length < 2) return null;
  const [x, y] = obs;
  return conflictBetween(x.value, y.value) ? obs : null;
}

export const deployPolicy: Policy = {
  name: 'deploy@cut1',
  actionType: 'deploy_release',
  requiredFields: ['service', 'environment', 'toArtifact', 'fromArtifact', 'trafficPercent', 'intent'],
  evidence: [
    { kind: 'telemetry', sources: { apm: 'ADAPTER', synthetic: 'ADAPTER' }, fields: ['service', 'environment'],
      subject: (a) => ({ service: String(p(a).service), env: String(p(a).environment), windowSec: TELEMETRY_WINDOW_SEC }),
      freshness: { type: 'MAX_AGE', ms: 5 * MIN }, binding: 'SNAPSHOT', timeoutMs: 15 * MIN,
      hypothetical: () => ({ errorRatePct: 0.4, p95Ms: 310 }) },
    { kind: 'ci_result', sources: { ci: 'ADAPTER' }, fields: ['toArtifact'],
      subject: (a) => ({ artifact: String(p(a).toArtifact) }),
      freshness: { type: 'DIGEST_BOUND' }, binding: 'SNAPSHOT', timeoutMs: 60 * MIN,
      hypothetical: () => ({ status: 'PASS' }) },
    { kind: 'rollback_drill', sources: { ci: 'ADAPTER' }, fields: ['fromArtifact', 'toArtifact', 'environment'],
      subject: drillSubject, freshness: { type: 'MAX_AGE', ms: 24 * HOUR }, binding: 'SNAPSHOT', timeoutMs: 4 * HOUR,
      hypothetical: () => ({ status: 'PASS' }) },
    { kind: 'migration_class', sources: { ci: 'ADAPTER' }, fields: ['toArtifact'],
      subject: (a) => ({ artifact: String(p(a).toArtifact) }),
      freshness: { type: 'DIGEST_BOUND' }, binding: 'SNAPSHOT', timeoutMs: 60 * MIN,
      hypothetical: () => ({ class: 'NONE' }) },
    { kind: 'deploy_state', sources: { deployer: 'ADAPTER' }, fields: ['service', 'environment'],
      subject: (a) => ({ service: String(p(a).service), env: String(p(a).environment) }),
      freshness: { type: 'READ_CURRENT_STATE' }, binding: 'PRECONDITION', timeoutMs: 30 * MIN },
  ],
  currentState: [{
    kind: 'deploy_state',
    compare: (a, v) => (['generation', 'currentArtifact', 'schemaVersion', 'configVersion'] as const)
      .filter((k) => v[k] !== a.expectedTargetVersions[k])
      .map((k) => `${k}: expected ${a.expectedTargetVersions[k]}, current ${v[k]}`),
  }],
  gates: [
    { id: 'D-TARGET', resolver: 'NONE', eval: (c) =>
      SERVICES[c.params.service] && ENVS.includes(c.params.environment) && Number.isInteger(c.params.trafficPercent) && c.params.trafficPercent >= 0 && c.params.trafficPercent <= 100
        ? { status: 'PASS' } : { status: 'FAIL', reasonCode: 'UNSUPPORTED_TARGET', observed: { service: c.params.service, environment: c.params.environment, trafficPercent: c.params.trafficPercent } } },
    { id: 'D-FROM', resolver: 'NONE', eval: (c) =>
      c.params.fromArtifact === c.action.expectedTargetVersions.currentArtifact ? { status: 'PASS' }
        : { status: 'FAIL', reasonCode: 'FROM_ARTIFACT_MISMATCH', observed: c.params.fromArtifact, required: `the artifact actually deployed: ${c.action.expectedTargetVersions.currentArtifact}` } },
    { id: 'D-INTENT', resolver: 'NONE', eval: (c) =>
      c.params.intent === 'ROUTINE' ? { status: 'PASS' }
        : { status: 'FAIL', reasonCode: 'UNSUPPORTED_PATH', observed: c.params.intent, required: 'ROUTINE — incident remediation must use the incident procedure' } },
    { id: 'D-CI-BAD', resolver: 'NONE', reads: ['ci_result'], eval: (c) =>
      c.val('ci_result').status === 'FAIL' ? { status: 'FAIL', reasonCode: 'CI_FAILED' } : { status: 'PASS' } },
    { id: 'D-CI-PENDING', resolver: 'EXTERNAL', reads: ['ci_result'], timeout: { type: 'OW', ms: 60 * MIN },
      repair: { kind: 'ci_result', value: { status: 'PASS' } }, eval: (c) =>
      c.val('ci_result').status === 'PENDING' ? { status: 'FAIL', reasonCode: 'CI_PENDING' } : { status: 'PASS' } },
    { id: 'D-MIG-DESTRUCTIVE', resolver: 'NONE', reads: ['migration_class'], eval: (c) =>
      c.val('migration_class').class === 'DESTRUCTIVE' ? { status: 'FAIL', reasonCode: 'DESTRUCTIVE_MIGRATION' } : { status: 'PASS' } },
    { id: 'D-TEL-CONFLICT', resolver: 'AUTHORITY', purpose: 'ADJUDICATE', role: 'sre-oncall', reads: ['telemetry'], decisions: ['SELECT_OBSERVATION', 'REJECT'], eval: (c) => {
      const conflict = telemetryConflict(c);
      if (!conflict) return { status: 'PASS' };
      const adj = c.adjudication('D-TEL-CONFLICT', conflictDigest(conflict));
      if (adj?.decision === 'REJECT') return { status: 'FAIL', resolver: 'NONE', reasonCode: 'ADJUDICATION_REJECTED' };
      if (adj?.decision === 'SELECT_OBSERVATION' && conflict.some((o) => obsId(o) === adj.selection)) return { status: 'PASS', observed: `selected ${adj.selection}` };
      return { status: 'FAIL', reasonCode: 'TELEMETRY_SOURCES_DISAGREE', observed: { conflictDigest: conflictDigest(conflict), candidates: conflict.map((o) => ({ observationId: obsId(o), source: o.sourceId, ...o.value })) } };
    } },
    { id: 'D-TEL-HEALTH', resolver: 'EXTERNAL', reads: ['telemetry'], dependsOn: ['D-TEL-CONFLICT'], timeout: { type: 'RW', ms: 15 * MIN },
      repair: { kind: 'telemetry', value: { errorRatePct: 0.4, p95Ms: 310 } }, eval: (c) => {
      const conflict = telemetryConflict(c);
      const sel = conflict ? c.adjudication('D-TEL-CONFLICT', conflictDigest(conflict))?.selection : undefined;
      const obs = conflict ? conflict.find((o) => obsId(o) === sel) : c.one('telemetry');
      if (!obs) throw new Error('evaluator bug: health evaluated without a valid conflict selection');
      return healthy(obs.value) ? { status: 'PASS', observed: obs.value }
        : { status: 'FAIL', reasonCode: 'TELEMETRY_UNHEALTHY', observed: obs.value, required: 'error rate < 2.0% and p95 < 800 ms' };
    } },
    { id: 'D-DRILL-BAD', resolver: 'NONE', reads: ['rollback_drill'], eval: (c) =>
      c.val('rollback_drill').status === 'FAIL' ? { status: 'FAIL', reasonCode: 'ROLLBACK_DRILL_FAILED', observed: c.val('rollback_drill') } : { status: 'PASS' } },
    { id: 'D-DRILL-PENDING', resolver: 'EXTERNAL', reads: ['rollback_drill'], dependsOn: ['D-CI-BAD', 'D-CI-PENDING'], timeout: { type: 'OW', ms: 4 * HOUR },
      repair: { kind: 'rollback_drill', value: { status: 'PASS' } }, eval: (c) =>
      c.val('rollback_drill').status === 'PENDING' ? { status: 'FAIL', reasonCode: 'ROLLBACK_DRILL_PENDING' } : { status: 'PASS' } },
    { id: 'D-LOCK', resolver: 'EXTERNAL', reads: ['deploy_state'], timeout: { type: 'RW', ms: 30 * MIN }, eval: (c) =>
      c.val('deploy_state').lockHolder ? { status: 'FAIL', reasonCode: 'DEPLOY_LOCK_HELD', observed: c.val('deploy_state').lockHolder } : { status: 'PASS' } },
    approveGate('D-APPROVE'),
  ],
  risk: (c) => {
    const { environment: env, service, trafficPercent: t } = c.params;
    const tier = SERVICES[service]?.tier ?? 2;
    const I = Math.min(3, (env === 'prod' ? 2 : env === 'staging' ? 1 : 0) + (tier === 1 ? 1 : 0));
    const B = env !== 'prod' ? 0 : t === 0 ? 0 : t <= 1 ? 1 : t <= 25 ? 2 : 3;
    const mig = c.admitted.migration_class[0]?.value.class;
    const drill = c.admitted.rollback_drill[0]?.value.status;
    const U = mig === undefined ? 'UNKNOWN' : mig === 'IRREVERSIBLE' || mig === 'DESTRUCTIVE' ? 3 : drill === 'PASS' ? 1 : 'UNKNOWN';
    return { I, B, U };
  },
  requiredRole: (t) => (t === 'HIGH' ? 'release-owner' : t === 'CRITICAL' ? 'eng-director' : null),
};

export const conflictDigest = (obs: { sourceId: string; sourceRevision: number; kind: string; subject: any }[]) =>
  digest(obs.map((o) => obsId(o as any)).sort());
