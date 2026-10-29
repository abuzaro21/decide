// Golden-fixture seeds (07 v2.1). Each scenario = base seed + delta.
import { MIN, approvalExpiry, type Action, type Observation, type Snapshot, type Approval, evaluateCore, type Policy, type Decision } from '../src/engine.ts';
import { deployPolicy } from '../src/policy/deploy.ts';

export const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
export const META = { policyHash: 'test-policy', evaluatorVersion: 'test' };

const obs = (kind: string, sourceId: string, subject: Observation['subject'], value: Observation['value'], ageMs = 0, rev = 1): Observation =>
  ({ kind, sourceId, sourceClass: 'ADAPTER', sourceRevision: rev, subject, value, observedAt: T0 - ageMs });

export function deployBase(over: Partial<Record<string, unknown>> = {}): Snapshot {
  const params = { service: 'checkout-api', environment: 'prod', toArtifact: 'sha256:9f3c', fromArtifact: 'sha256:2134', trafficPercent: 100, intent: 'ROUTINE', ...over };
  const action: Action = {
    schemaVersion: 1, sessionId: 's1', runId: 'r1', initiatingPrincipal: 'agent:deploy-bot', proposalId: 'p1', revision: 1,
    actionType: 'deploy_release', params,
    expectedTargetVersions: { generation: 88, currentArtifact: 'sha256:2134', schemaVersion: 41, configVersion: 7 },
    recoveryScope: { procedureHash: 'proc-h' },
  };
  const tel = { service: String(params.service), env: String(params.environment) };
  const art = { artifact: String(params.toArtifact) };
  const drill = { from: String(params.fromArtifact), to: String(params.toArtifact), env: String(params.environment), schemaVersion: 41, configVersion: 7, procedureHash: 'proc-h' };
  return {
    action, now: T0, approvals: [], adjudications: [], timers: {}, agentConfidence: 0.99,
    roles: { 'human:rhea': ['release-owner'], 'human:omar': ['eng-director'], 'human:sam': ['sre-oncall'] },
    candidates: [
      obs('telemetry', 'apm', tel, { errorRatePct: 0.4, p95Ms: 310 }, 1 * MIN),
      obs('telemetry', 'synthetic', tel, { errorRatePct: 0.5, p95Ms: 330 }, 1 * MIN),
      obs('ci_result', 'ci', art, { status: 'PASS' }, 60 * MIN),
      obs('migration_class', 'ci', art, { class: 'NONE' }, 60 * MIN),
      obs('rollback_drill', 'ci', drill, { status: 'PASS' }, 14 * MIN),
      obs('deploy_state', 'deployer', tel, { generation: 88, currentArtifact: 'sha256:2134', schemaVersion: 41, configVersion: 7, lockHolder: null }, 0),
    ],
  };
}

export const without = (s: Snapshot, kind: string, sourceId?: string): Snapshot =>
  ({ ...s, candidates: s.candidates.filter((o) => !(o.kind === kind && (!sourceId || o.sourceId === sourceId))) });

export const withObs = (s: Snapshot, kind: string, sourceId: string, value: Observation['value'], patch: Partial<Observation> = {}): Snapshot => {
  const prev = s.candidates.find((o) => o.kind === kind && o.sourceId === sourceId) ?? s.candidates.find((o) => o.kind === kind)!;
  const next: Observation = { ...prev, sourceId, value, sourceRevision: (prev?.sourceRevision ?? 0) + 1, observedAt: s.now, ...patch };
  return { ...s, candidates: [...s.candidates, next] };
};

export const decide = (s: Snapshot, policy: Policy = deployPolicy): Decision => evaluateCore(policy, s, META);
export const failIds = (d: Decision) => d.obligations.map((g) => g.gateId).sort();
export const blockedIds = (d: Decision) => d.later.map((g) => g.gateId).sort();

/** A genuine strict-snapshot approval for the current decision (as the approval service would grant it). */
export function approve(s: Snapshot, approverId: string, policy: Policy = deployPolicy): Snapshot {
  const d = decide(s, policy);
  const role = policy.requiredRole(d.risk!.tier)!;
  const ap: Approval = {
    approvalId: `ap-${s.approvals.length + 1}`, revision: s.action.revision, fingerprint: d.fingerprint, ...META,
    snapshotRoot: d.snapshotRoot, preconditions: d.preconditions, reviewedRisk: d.risk!, requiredRole: role, approverId,
    issuedAt: s.now, expiresAt: approvalExpiry(policy, s, d), status: 'ACTIVE',
  };
  return { ...s, approvals: [...s.approvals, ap] };
}
