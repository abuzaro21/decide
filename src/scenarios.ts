// Named demo/test scenarios: seed the simulated world + roles, then create the agent's proposal.
// Seeds mirror the 07 v2.1 base seeds. Everything here is SIMULATED and labelled as such in the UI.
import { tx, type Db } from './db.ts';
import { MIN } from './engine.ts';
import { ensureSession, propose, type Proposer } from './store.ts';
import { publish, readObs, PROCEDURE_HASH, type Scope } from './world.ts';

export const DEMO_ROLES: Record<string, string[]> = {
  'human:rhea': ['release-owner'], 'human:omar': ['eng-director'], 'human:sam': ['sre-oncall'], 'human:op': ['operator'],
  'human:ana': ['ap-manager'], 'human:fin': ['finance-controller'], 'human:sec': ['security-lead'],
};

type DeployVariant = 'confidence-trap' | 'canary' | 'ready-for-review' | 'both-monitors-blind';

export interface Scenario { id: string; title: string; domain: string; seed: (db: Db, s: Scope, now: number) => { proposalId: string } }

function seedDeployWorld(db: Db, s: Scope, now: number, o: { service: string; telemetryAgeMs: number | null; drill: 'PASS' | null; hiddenRealUserErrorPct?: number }) {
  const target = { service: o.service, env: 'prod' };
  const tel = { ...target, windowSec: 300 };
  tx(db, () => {
    publish(db, s, { kind: 'deploy_state', sourceId: 'deployer', sourceClass: 'ADAPTER', subject: target,
      value: { generation: 88, currentArtifact: 'sha256:2134', schemaVersion: 41, configVersion: 7, lockHolder: null, ...(o.hiddenRealUserErrorPct !== undefined ? { hiddenRealUserErrorPct: o.hiddenRealUserErrorPct } : {}) } }, now, now);
    if (o.telemetryAgeMs !== null) {
      publish(db, s, { kind: 'telemetry', sourceId: 'apm', sourceClass: 'ADAPTER', subject: tel, value: { errorRatePct: 0.4, p95Ms: 310 } }, now, now - o.telemetryAgeMs);
      publish(db, s, { kind: 'telemetry', sourceId: 'synthetic', sourceClass: 'ADAPTER', subject: tel, value: { errorRatePct: 0.5, p95Ms: 330 } }, now, now - o.telemetryAgeMs);
    }
    const art = { artifact: 'sha256:9f3c' };
    publish(db, s, { kind: 'ci_result', sourceId: 'ci', sourceClass: 'ADAPTER', subject: art, value: { status: 'PASS' } }, now, now - 60 * MIN);
    publish(db, s, { kind: 'migration_class', sourceId: 'ci', sourceClass: 'ADAPTER', subject: art, value: { class: 'NONE' } }, now, now - 60 * MIN);
    if (o.drill) publish(db, s, { kind: 'rollback_drill', sourceId: 'ci', sourceClass: 'ADAPTER',
      subject: { from: 'sha256:2134', to: 'sha256:9f3c', env: 'prod', schemaVersion: 41, configVersion: 7, procedureHash: PROCEDURE_HASH },
      value: { status: o.drill } }, now, now - 14 * MIN);
  });
}

/** The recorded proposer output used when no API key is configured is attached by the caller; manual seeds say MANUAL. */
const seedProposer: Proposer = { kind: 'MANUAL', agentConfidence: 0.99, rationale: 'Rollback tested, metrics look healthy. Ship it to everyone.' };

export function seedDeploy(db: Db, s: Scope, now: number, variant: DeployVariant, proposer: Proposer = seedProposer) {
  ensureSession(db, s, now, DEMO_ROLES);
  const canary = variant === 'canary';
  seedDeployWorld(db, s, now, {
    service: canary ? 'search-api' : 'checkout-api',
    telemetryAgeMs: variant === 'confidence-trap' ? 47 * MIN : 1 * MIN,
    drill: variant === 'confidence-trap' ? null : 'PASS',
    ...(variant === 'both-monitors-blind' ? { hiddenRealUserErrorPct: 9 } : {}),
  });
  return propose(db, s, {
    actionType: 'deploy_release', initiatingPrincipal: 'agent:deploy-bot', proposer,
    params: { service: canary ? 'search-api' : 'checkout-api', environment: 'prod', toArtifact: 'sha256:9f3c', fromArtifact: 'sha256:2134', trafficPercent: canary ? 1 : 100, intent: 'ROUTINE' },
  }, now);
}

/** Simulated external-world events, scoped to the proposal's own subject. They change the WORLD; evidence is then collected. They cannot create approvals. */
export interface Control { id: string; label: string; domain: string; apply: (db: Db, s: Scope, a: import('./engine.ts').Action, now: number) => void }
const dp = (a: import('./engine.ts').Action) => a.params as Record<string, any>;
const telSubject = (a: import('./engine.ts').Action) => ({ service: String(dp(a).service), env: String(dp(a).environment), windowSec: 300 });
const drillSubject = (a: import('./engine.ts').Action) => ({ from: String(dp(a).fromArtifact), to: String(dp(a).toArtifact), env: String(dp(a).environment), schemaVersion: a.expectedTargetVersions.schemaVersion, configVersion: a.expectedTargetVersions.configVersion, procedureHash: a.recoveryScope.procedureHash });
const tel = (db: Db, s: Scope, a: any, now: number, apm: [number, number] | null, syn: [number, number] | null) => {
  if (apm) publish(db, s, { kind: 'telemetry', sourceId: 'apm', sourceClass: 'ADAPTER', subject: telSubject(a), value: { errorRatePct: apm[0], p95Ms: apm[1] } }, now);
  if (syn) publish(db, s, { kind: 'telemetry', sourceId: 'synthetic', sourceClass: 'ADAPTER', subject: telSubject(a), value: { errorRatePct: syn[0], p95Ms: syn[1] } }, now);
};
export const CONTROLS: Control[] = [
  { id: 'telemetry-healthy', label: 'Monitoring publishes fresh, healthy telemetry (both sources)', domain: 'deploy_release', apply: (db, s, a, now) => tel(db, s, a, now, [0.4, 310], [0.5, 330]) },
  { id: 'telemetry-red-both', label: 'Both monitors report 3.2% errors', domain: 'deploy_release', apply: (db, s, a, now) => tel(db, s, a, now, [3.2, 310], [3.2, 330]) },
  { id: 'telemetry-red-apm', label: 'Only APM reports 3.2% errors (sources now disagree)', domain: 'deploy_release', apply: (db, s, a, now) => tel(db, s, a, now, [3.2, 310], null) },
  { id: 'drill-pass', label: 'CI rollback drill passes for this exact release pair', domain: 'deploy_release', apply: (db, s, a, now) => publish(db, s, { kind: 'rollback_drill', sourceId: 'ci', sourceClass: 'ADAPTER', subject: drillSubject(a), value: { status: 'PASS' } }, now) },
  { id: 'drill-fail', label: 'CI rollback drill FAILS for this exact release pair', domain: 'deploy_release', apply: (db, s, a, now) => publish(db, s, { kind: 'rollback_drill', sourceId: 'ci', sourceClass: 'ADAPTER', subject: drillSubject(a), value: { status: 'FAIL' } }, now) },
  { id: 'ci-pass-new-artifact', label: 'CI passes for the proposed artifact (no migration)', domain: 'deploy_release', apply: (db, s, a, now) => {
    const art = { artifact: String(dp(a).toArtifact) };
    publish(db, s, { kind: 'ci_result', sourceId: 'ci', sourceClass: 'ADAPTER', subject: art, value: { status: 'PASS' } }, now);
    publish(db, s, { kind: 'migration_class', sourceId: 'ci', sourceClass: 'ADAPTER', subject: art, value: { class: 'NONE' } }, now);
  } },
  { id: 'lock-taken', label: 'Another deploy takes the deploy lock', domain: 'deploy_release', apply: (db, s, a, now) => {
    const subj = { service: String(dp(a).service), env: String(dp(a).environment) };
    const cur = readObs(db, s, 'deploy_state', 'deployer', subj);
    if (cur) publish(db, s, { kind: 'deploy_state', sourceId: 'deployer', sourceClass: 'ADAPTER', subject: subj, value: { ...cur.value, lockHolder: 'deploy-7731' } }, now);
  } },
];

export const SCENARIOS: Scenario[] = [
  { id: 'confidence-trap', title: 'The Confidence Trap — 99% sure, stale telemetry, no rollback drill', domain: 'deploy_release', seed: (db, s, now) => seedDeploy(db, s, now, 'confidence-trap') },
  { id: 'deploy-ready', title: 'Fully evidenced production deploy awaiting the release owner', domain: 'deploy_release', seed: (db, s, now) => seedDeploy(db, s, now, 'ready-for-review') },
  { id: 'deploy-canary', title: '1% canary of a tier-2 service', domain: 'deploy_release', seed: (db, s, now) => seedDeploy(db, s, now, 'canary') },
  { id: 'both-monitors-blind', title: 'Known failure — both monitors report green while real users fail', domain: 'deploy_release', seed: (db, s, now) => seedDeploy(db, s, now, 'both-monitors-blind') },
];
