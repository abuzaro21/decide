// DEP golden fixtures (07 v2.1, policy deploy@cut1). Pure evaluator, no DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN, explainRepairs, observationId } from '../src/engine.ts';
import { deployPolicy, conflictDigest } from '../src/policy/deploy.ts';
import { deployBase, without, withObs, decide, failIds, blockedIds, approve, META, T0 } from './fixtures.ts';

const dep1 = () => without(without(deployBase(), 'rollback_drill'), 'telemetry');
const stale = (s: ReturnType<typeof deployBase>) => ({ ...s, candidates: s.candidates.map((o) => (o.kind === 'telemetry' ? { ...o, observedAt: T0 - 47 * MIN } : o)) });

test('DEP-1 Confidence Trap: 99% agent, stale telemetry, no drill → DEFER; approval later; evidence 4/5', () => {
  const s = stale(without(deployBase(), 'rollback_drill'));
  const d = decide(s);
  assert.equal(d.outcome, 'DEFER');
  assert.deepEqual(failIds(d), ['AVAIL(rollback_drill)', 'AVAIL(telemetry)']);
  assert.deepEqual(blockedIds(d), ['D-APPROVE', 'D-DRILL-BAD', 'D-DRILL-PENDING', 'D-TEL-CONFLICT', 'D-TEL-HEALTH']);
  assert.deepEqual(d.risk, { I: 3, B: 3, U: 3, uUnknown: true, tier: 'CRITICAL' });
  assert.equal(d.display.agentConfidence.value, 0.99);
  assert.deepEqual(d.display.evidenceCoverage, { available: 3, required: 5 }); // deploy@cut1 has 5 slots (calendar cut)
  assert.equal(d.display.evidenceSupport, 'INCOMPLETE');
  assert.equal(d.rejected.filter((r) => r.reason === 'EXPIRED').length, 2);
});

test('DEP-2 fresh telemetry, still no drill → DEFER on drill only', () => {
  const d = decide(without(deployBase(), 'rollback_drill'));
  assert.equal(d.outcome, 'DEFER');
  assert.deepEqual(failIds(d), ['AVAIL(rollback_drill)']);
  assert.deepEqual(blockedIds(d), ['D-APPROVE', 'D-DRILL-BAD', 'D-DRILL-PENDING']);
});

test('DEP-3 base → ESCALATE (APPROVE release-owner), HIGH I3·B3·U1, risk score 3/4', () => {
  const d = decide(deployBase());
  assert.equal(d.outcome, 'ESCALATE');
  assert.deepEqual(failIds(d), ['D-APPROVE']);
  assert.equal(d.obligations[0].required, 'release-owner');
  assert.deepEqual(d.risk, { I: 3, B: 3, U: 1, uUnknown: false, tier: 'HIGH' });
  assert.deepEqual(d.display.riskScore, { ordinal: 3, of: 4, tier: 'HIGH', components: 'I3·B3·U1' });
  assert.equal(d.display.evidenceSupport, 'COMPLETE');
});

test('DEP-4 approved (OPEN) → EXECUTE; approval by requester or wrong role does not count', () => {
  assert.equal(decide(approve(deployBase(), 'human:rhea')).outcome, 'EXECUTE');
  const self = approve({ ...deployBase(), roles: { 'agent:deploy-bot': ['release-owner'] } }, 'agent:deploy-bot');
  assert.equal(decide(self).outcome, 'ESCALATE');
  const wrongRole = approve(deployBase(), 'human:rhea');
  assert.equal(decide({ ...wrongRole, roles: { 'human:rhea': ['sre-oncall'] } }).outcome, 'ESCALATE');
});

test('DEP-5 new artifact revision: approval invalid, DEFER on CI/drill/migration availability', () => {
  const approved = approve(deployBase(), 'human:rhea');
  const rev2 = { ...approved, action: { ...approved.action, revision: 2, params: { ...approved.action.params, toArtifact: 'sha256:a1' } } };
  const d = decide(rev2);
  assert.equal(d.outcome, 'DEFER');
  assert.deepEqual(failIds(d), ['AVAIL(ci_result)', 'AVAIL(migration_class)', 'AVAIL(rollback_drill)']);
  assert.ok(d.rejected.every((r) => r.reason === 'SUBJECT_MISMATCH'));
});

test('DEP-6 drill FAIL for current bindings → REFUSE; DEP-6b wrong-subject drill → DEFER (missing proof)', () => {
  const s = withObs(without(deployBase(), 'rollback_drill'), 'rollback_drill', 'ci', { status: 'FAIL' },
    { kind: 'rollback_drill', subject: { from: 'sha256:2134', to: 'sha256:9f3c', env: 'prod', schemaVersion: 41, configVersion: 7, procedureHash: 'proc-h' }, sourceClass: 'ADAPTER', sourceRevision: 1 });
  const d = decide(s);
  assert.equal(d.outcome, 'REFUSE');
  assert.deepEqual(failIds(d), ['D-DRILL-BAD']);
  assert.equal(d.display.evidenceSupport, 'ADVERSE');
  const wrong = { ...s, candidates: s.candidates.map((o) => (o.kind === 'rollback_drill' ? { ...o, subject: { ...o.subject, schemaVersion: 42 } } : o)) };
  const d2 = decide(wrong);
  assert.equal(d2.outcome, 'DEFER');
  assert.deepEqual(failIds(d2), ['AVAIL(rollback_drill)']);
});

test('DEP-7 / DEP-7b telemetry conflict (incl. boundary 1.5% vs 2.4%) → ESCALATE adjudicate; selection resolves', () => {
  for (const [apm, syn] of [[0.3, 4.1], [1.5, 2.4]]) {
    const s = withObs(withObs(deployBase(), 'telemetry', 'apm', { errorRatePct: apm, p95Ms: 310 }), 'telemetry', 'synthetic', { errorRatePct: syn, p95Ms: 330 });
    const d = decide(s);
    assert.equal(d.outcome, 'ESCALATE', `${apm} vs ${syn}`);
    assert.deepEqual(failIds(d), ['D-TEL-CONFLICT']);
    assert.equal(d.display.evidenceSupport, 'CONTESTED');
    // Adjudicator selects the unhealthy synthetic reading -> conflict PASS, health DEFER.
    const fresh = s.candidates.filter((o) => o.kind === 'telemetry' && o.observedAt === T0);
    const syntheticObs = fresh.find((o) => o.sourceId === 'synthetic')!;
    const adj = { revision: 1, gateId: 'D-TEL-CONFLICT', conflictDigest: conflictDigest(fresh.sort((a, b) => a.sourceId.localeCompare(b.sourceId))), decision: 'SELECT_OBSERVATION',
      selection: observationId(syntheticObs), role: 'sre-oncall', actor: 'human:sam' };
    const d2 = decide({ ...s, adjudications: [adj] });
    assert.equal(d2.outcome, 'DEFER');
    assert.deepEqual(failIds(d2), ['D-TEL-HEALTH']);
    assert.equal(decide({ ...s, adjudications: [{ ...adj, decision: 'REJECT' }] }).outcome, 'REFUSE');
  }
});

test('DEP-8 missing trafficPercent → ASK; dependents BLOCKED', () => {
  const d = decide(deployBase({ trafficPercent: undefined }));
  assert.equal(d.outcome, 'ASK');
  assert.deepEqual(failIds(d), ['FIELDS']);
  assert.deepEqual(d.obligations[0].required, ['trafficPercent']);
});

test('DEP-9 tier-2 1% canary → EXECUTE without approval (MEDIUM)', () => {
  const d = decide(deployBase({ service: 'search-api', trafficPercent: 1 }));
  assert.equal(d.outcome, 'EXECUTE');
  assert.equal(d.risk!.tier, 'MEDIUM');
  assert.equal(d.gates.find((g) => g.gateId === 'D-APPROVE')!.status, 'NOT_APPLICABLE');
});

test('DEP-10 both monitors red after approval → DEFER, approval invalid (Phase 0 D-1 fix)', () => {
  const approved = approve(deployBase(), 'human:rhea');
  const red = withObs(withObs(approved, 'telemetry', 'apm', { errorRatePct: 3.2, p95Ms: 310 }), 'telemetry', 'synthetic', { errorRatePct: 3.2, p95Ms: 330 });
  const d = decide(red);
  assert.equal(d.outcome, 'DEFER');
  assert.deepEqual(failIds(d), ['D-TEL-HEALTH']);
  // and once telemetry recovers, the old approval is still dead (snapshot changed) -> ESCALATE
  const recovered = withObs(withObs(red, 'telemetry', 'apm', { errorRatePct: 0.4, p95Ms: 310 }, { sourceRevision: 9 }), 'telemetry', 'synthetic', { errorRatePct: 0.5, p95Ms: 330 }, { sourceRevision: 9 });
  const d2 = decide(recovered);
  assert.equal(d2.outcome, 'ESCALATE');
  assert.match(JSON.stringify(d2.obligations[0].observed), /evidence snapshot changed/);
});

test('DEP-10b only one monitor red → ESCALATE adjudicate, not DEFER (Phase 0 D-1 precise issue)', () => {
  const approved = approve(deployBase(), 'human:rhea');
  const d = decide(withObs(approved, 'telemetry', 'apm', { errorRatePct: 3.2, p95Ms: 310 }));
  assert.equal(d.outcome, 'ESCALATE');
  assert.deepEqual(failIds(d), ['D-TEL-CONFLICT']);
  assert.deepEqual(blockedIds(d), ['D-APPROVE', 'D-TEL-HEALTH']);
});

test('DEP-12 destructive migration → REFUSE; DEP-14 incident relabel → REFUSE UNSUPPORTED_PATH', () => {
  const d = decide(withObs(deployBase(), 'migration_class', 'ci', { class: 'DESTRUCTIVE' }));
  assert.equal(d.outcome, 'REFUSE');
  assert.deepEqual(failIds(d), ['D-MIG-DESTRUCTIVE']);
  const red = withObs(withObs(deployBase({ intent: 'INCIDENT_REMEDIATION' }), 'telemetry', 'apm', { errorRatePct: 8, p95Ms: 900 }), 'telemetry', 'synthetic', { errorRatePct: 8.2, p95Ms: 910 });
  const d14 = decide(red);
  assert.equal(d14.outcome, 'REFUSE');
  assert.deepEqual(failIds(d14), ['D-INTENT', 'D-TEL-HEALTH']);
});

test('DEP-16 telemetry timeout at deadline (inclusive) → ESCALATE TIMEOUT; 1 ms before → DEFER (ST-7); CANCEL → REFUSE', () => {
  const s0 = dep1();
  const first = decide(s0);
  const timer = first.timerUpdates['AVAIL(telemetry)'];
  assert.deepEqual(timer, { firstBlockedAt: T0, deadlineAt: T0 + 15 * MIN, extended: false });
  const at = (ms: number) => ({ ...s0, now: ms, timers: first.timerUpdates });
  const before = decide(at(T0 + 15 * MIN - 1));
  assert.equal(before.outcome, 'DEFER');
  const due = decide(at(T0 + 15 * MIN));
  assert.equal(due.outcome, 'ESCALATE');
  assert.deepEqual(failIds(due), ['AVAIL(rollback_drill)', 'AVAIL(telemetry)']);
  const tel = due.obligations.find((g) => g.gateId === 'AVAIL(telemetry)')!;
  assert.equal(tel.purpose, 'TIMEOUT');
  assert.equal(tel.role, 'operator');
  const cancelled = decide({ ...at(T0 + 15 * MIN), adjudications: [{ revision: 1, gateId: 'AVAIL(telemetry)', conflictDigest: '', decision: 'CANCEL', role: 'operator', actor: 'human:op' }] });
  assert.equal(cancelled.outcome, 'REFUSE');
  // EXTEND_ONCE: store sets extended deadline; engine honours it.
  const extended = decide({ ...at(T0 + 16 * MIN), timers: { ...first.timerUpdates, 'AVAIL(telemetry)': { firstBlockedAt: T0, deadlineAt: T0 + 31 * MIN, extended: true } } });
  assert.equal(extended.obligations.find((g) => g.gateId === 'AVAIL(telemetry)')!.purpose, undefined);
  assert.equal(extended.outcome, 'DEFER');
});

test('DEP-17 lock held → DEFER; DEP-18 generation changed → REFUSE STALE_PROPOSAL at any tier', () => {
  const locked = withObs(deployBase(), 'deploy_state', 'deployer', { generation: 88, currentArtifact: 'sha256:2134', schemaVersion: 41, configVersion: 7, lockHolder: 'deploy-7731' });
  assert.equal(decide(locked).outcome, 'DEFER');
  assert.deepEqual(failIds(decide(locked)), ['D-LOCK']);
  for (const s of [deployBase(), deployBase({ service: 'search-api', trafficPercent: 1 })]) {
    const d = decide(withObs(s, 'deploy_state', 'deployer', { generation: 89, currentArtifact: 'sha256:2134', schemaVersion: 41, configVersion: 7, lockHolder: null }));
    assert.equal(d.outcome, 'REFUSE');
    assert.deepEqual(failIds(d), ['VERSIONS']);
    assert.equal(d.obligations[0].reasonCode, 'STALE_PROPOSAL');
  }
});

test('admission: requester-claimed apm source, future-dated and boundary-expired telemetry are rejected (T-02, T-03)', () => {
  const s = without(deployBase(), 'telemetry');
  const tel = { service: 'checkout-api', env: 'prod' };
  const mk = (o: object) => ({ kind: 'telemetry', sourceId: 'apm', sourceClass: 'ADAPTER' as const, sourceRevision: 1, subject: tel, value: { errorRatePct: 0.1, p95Ms: 100 }, observedAt: T0, ...o });
  const cases: [object, string | null][] = [
    [{ sourceClass: 'REQUESTER' }, 'SOURCE_NOT_ACCEPTED'],
    [{ observedAt: T0 + 6000 }, 'FUTURE_DATED'],
    [{ observedAt: T0 + 5000 }, null],
    [{ observedAt: T0 - 5 * MIN }, 'EXPIRED'],
    [{ observedAt: T0 - 5 * MIN + 1 }, null],
    [{ subject: { service: 'checkout-api', env: 'staging' } }, 'SUBJECT_MISMATCH'],
  ];
  for (const [patch, reason] of cases) {
    const d = decide({ ...s, candidates: [...s.candidates, mk(patch)] });
    if (reason) { assert.equal(d.rejected[0]?.reason, reason, JSON.stringify(patch)); assert.ok(failIds(d).includes('AVAIL(telemetry)')); }
    else assert.ok(!failIds(d).includes('AVAIL(telemetry)'), JSON.stringify(patch));
  }
});

test('what-would-change: bounded previews, never executable, combined only with ≥2 repairs (ST-2)', () => {
  const s = dep1();
  const core = decide(s);
  const w = explainRepairs(deployPolicy, s, META, core);
  assert.equal(w.single.length, 2);
  assert.ok(w.single.every((x) => x.outcome === 'DEFER'));
  assert.equal(w.combined!.outcome, 'ESCALATE');
  assert.deepEqual(w.combined!.remaining, ['D-APPROVE']);
  const esc = explainRepairs(deployPolicy, deployBase(), META, decide(deployBase()));
  assert.equal(esc.single[0].outcome, 'EXECUTE');
  assert.equal(esc.combined, null);
  // Preview approvals are rejected in LIVE evaluation.
  const all = explainRepairs(deployPolicy, approve(deployBase(), 'human:rhea'), META, decide(approve(deployBase(), 'human:rhea')));
  assert.equal(all.single.length, 0);
  assert.equal(all.combined, null);
});
