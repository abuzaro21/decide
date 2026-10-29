// G2 — durable store + the single transactional execution path, against a real SQLite file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { openDb, verifyChain, auditLog, audit, type Db } from '../src/db.ts';
import { fileURLToPath } from 'node:url';
import { execute, view, replay, propose, getReceipt, HttpError, operationIdOf } from '../src/store.ts';
import { SCENARIOS, DEMO_ROLES } from '../src/scenarios.ts';
const seedDeploy = (db: Db, s: { sessionId: string; runId: string }, now: number, id: string) => SCENARIOS.find((x) => x.id === (id === 'canary' ? 'deploy-canary' : id))!.seed(db, s, now);
import { ensureSession } from '../src/store.ts';
import { readObs, publish } from '../src/world.ts';
import { tx } from '../src/db.ts';
import { MIN } from '../src/engine.ts';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const S = { sessionId: 'sess-a', runId: 'run-1' };
const CHILD = new URL('./support/exec-child.ts', import.meta.url);

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'decide-g2-'));
  const file = join(dir, 'decide.db');
  const db = openDb(file);
  return { file, db, done: () => { if (db.isOpen) db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const generation = (db: Db, service = 'search-api') => (readObs(db, S, 'deploy_state', 'deployer', { service, env: 'prod' })!.value as any).generation;
const count = (db: Db, sql: string, ...p: any[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const throwsHttp = (fn: () => unknown, status: number, match?: RegExp) => {
  try { fn(); } catch (e) {
    assert.ok(e instanceof HttpError, String(e));
    assert.equal(e.status, status, JSON.stringify(e.body));
    if (match) assert.match(JSON.stringify(e.body), match);
    return e;
  }
  assert.fail('expected HttpError');
};

test('DEP-9 end to end: propose → EXECUTE → execute → receipt; retry replays the same receipt; exactly one effect', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'canary');
    const v = view(db, S, proposalId, NOW);
    assert.equal(v.decision!.outcome, 'EXECUTE');
    const r1 = execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW + 1000);
    assert.equal(r1.status, 'SUCCEEDED');
    assert.equal(generation(db), 89);
    const r2 = execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW + 2000);
    assert.deepEqual(r2, { ...r1, replayed: true });
    assert.equal(generation(db), 89, 'retry must not re-apply the effect');
    const after = view(db, S, proposalId, NOW + 3000);
    assert.equal(after.status, 'CLOSED_EXECUTED');
    assert.deepEqual(after.receipt, (r1 as any).receipt);
    assert.equal(count(db, 'SELECT count(*) n FROM receipts'), 1);
    const chain = verifyChain(db, S.sessionId, S.runId);
    assert.ok(chain.ok);
    assert.deepEqual(auditLog(db, S.sessionId, S.runId).map((r) => JSON.parse(r.envelope_json).type),
      ['SESSION_STARTED', 'WORLD_SEEDED', 'PROPOSED', 'EVALUATED', 'EVALUATED', 'EXECUTED']);
  } finally { done(); }
});

test('no execution unless the in-transaction re-evaluation says EXECUTE (Confidence Trap → DEFER, no receipt)', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'confidence-trap');
    const r = execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW);
    assert.equal(r.status, 'NOT_EXECUTED');
    assert.equal((r as any).decision.outcome, 'DEFER');
    assert.equal(count(db, 'SELECT count(*) n FROM receipts'), 0);
    assert.equal(generation(db, 'checkout-api'), 88);
  } finally { done(); }
});

test('revalidation at execute: world changes after a view said EXECUTE → stale proposal REFUSED, revision closed, then 409', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'canary');
    assert.equal(view(db, S, proposalId, NOW).decision!.outcome, 'EXECUTE');
    // someone else deploys first
    tx(db, () => publish(db, S, { kind: 'deploy_state', sourceId: 'deployer', sourceClass: 'ADAPTER', subject: { service: 'search-api', env: 'prod' },
      value: { generation: 89, currentArtifact: 'sha256:other', schemaVersion: 41, configVersion: 7, lockHolder: null } }, NOW + 1));
    const r = execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW + 2);
    assert.equal(r.status, 'NOT_EXECUTED');
    assert.equal((r as any).decision.outcome, 'REFUSE');
    assert.equal((r as any).decision.obligations[0].reasonCode, 'STALE_PROPOSAL');
    assert.equal(view(db, S, proposalId, NOW + 3).status, 'CLOSED_REFUSED');
    throwsHttp(() => execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW + 4), 409, /CLOSED_REFUSED/);
    assert.equal(count(db, 'SELECT count(*) n FROM receipts'), 0);
  } finally { done(); }
});

test('new revision supersedes the old one atomically; executing the superseded revision → 409, no effect', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'canary');
    const p2 = propose(db, S, { proposalId, actionType: 'deploy_release', initiatingPrincipal: 'agent:deploy-bot', proposer: { kind: 'MANUAL' },
      params: { service: 'search-api', environment: 'prod', toArtifact: 'sha256:a1', fromArtifact: 'sha256:2134', trafficPercent: 1, intent: 'ROUTINE' } }, NOW + 1);
    assert.equal(p2.revision, 2);
    throwsHttp(() => execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW + 2), 409, /SUPERSEDED/);
    const r = execute(db, S, proposalId, 2, 'agent:deploy-bot', NOW + 2);
    assert.equal(r.status, 'NOT_EXECUTED'); // rev 2 has no CI/drill/migration evidence for sha256:a1
    assert.equal((r as any).decision.outcome, 'DEFER');
    assert.equal(generation(db), 88);
  } finally { done(); }
});

test('session isolation: another session cannot view, execute or read receipts of this proposal', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'canary');
    const ok = execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW) as any;
    const B = { sessionId: 'sess-b', runId: 'run-1' };
    ensureSession(db, B, NOW, DEMO_ROLES);
    throwsHttp(() => view(db, B, proposalId, NOW), 404);
    throwsHttp(() => execute(db, B, proposalId, 1, 'agent:deploy-bot', NOW), 404);
    throwsHttp(() => getReceipt(db, B, ok.operationId), 404);
    throwsHttp(() => replay(db, B, ok.receipt.decisionId), 404);
    const oldRun = { sessionId: 'sess-a', runId: 'run-0' };
    throwsHttp(() => view(db, oldRun, proposalId, NOW), 404);
    assert.notEqual(operationIdOf(S, proposalId, 1), operationIdOf(B, proposalId, 1));
  } finally { done(); }
});

test('replay: every stored decision replays identically; tampered evaluator version → NOT_REPLAYABLE', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'confidence-trap');
    view(db, S, proposalId, NOW);
    tx(db, () => publish(db, S, { kind: 'telemetry', sourceId: 'apm', sourceClass: 'REQUESTER', subject: { service: 'checkout-api', env: 'prod', windowSec: 300 }, value: { errorRatePct: 0.1, p95Ms: 100 } }, NOW + MIN));
    view(db, S, proposalId, NOW + MIN);
    const ids = (db.prepare('SELECT decision_id FROM decisions').all() as { decision_id: string }[]).map((r) => r.decision_id);
    assert.ok(ids.length >= 2);
    for (const id of ids) { const r = replay(db, S, id) as any; assert.equal(r.replayable, true); assert.equal(r.identical, true, id); }
    // the requester-asserted "apm" reading was rejected, and the rejection replays too
    const last = JSON.parse((db.prepare('SELECT decision_json FROM decisions ORDER BY at DESC, rowid DESC LIMIT 1').get() as any).decision_json);
    assert.ok(last.rejected.some((x: any) => x.reason === 'SOURCE_NOT_ACCEPTED'));
    db.exec(`UPDATE decisions SET evaluator_version='eval-old' WHERE decision_id='${ids[0]}'`);
    assert.match((replay(db, S, ids[0]) as any).reason, /NOT_REPLAYABLE/);
  } finally { done(); }
});

test('audit chain: append-only triggers; edit detected; whole-chain rewrite detected against an exported head', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'canary');
    execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW);
    const head = (verifyChain(db, S.sessionId, S.runId) as any).head;
    assert.throws(() => db.exec("UPDATE audit SET hash='x'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM audit'), /append-only/);
    // DB-level attacker: drops triggers, edits one field of one envelope.
    db.exec('DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete;');
    const row = auditLog(db, S.sessionId, S.runId)[2];
    const env = JSON.parse(row.envelope_json);
    for (const field of ['type', 'actor', 'proposalId', 'ts']) {
      const tampered = { ...env, [field]: field === 'ts' ? env.ts + 1 : 'forged' };
      db.prepare('UPDATE audit SET envelope_json=? WHERE seq=?').run(JSON.stringify(tampered), row.seq);
      assert.equal(verifyChain(db, S.sessionId, S.runId).ok, false, field);
    }
    db.prepare('UPDATE audit SET envelope_json=? WHERE seq=?').run(row.envelope_json, row.seq);
    assert.ok(verifyChain(db, S.sessionId, S.runId, head).ok);
    // Rewrite the entire chain consistently: internally valid, but the exported head no longer matches (K-5 honesty).
    db.exec('DELETE FROM audit');
    db.exec('BEGIN');
    audit(db, S.sessionId, S.runId, NOW, { type: 'SESSION_STARTED', actor: 'attacker', payload: {} });
    db.exec('COMMIT');
    assert.equal(verifyChain(db, S.sessionId, S.runId).ok, true);
    assert.equal(verifyChain(db, S.sessionId, S.runId, head).ok, false);
  } finally { done(); }
});

test('pre-commit faults (throw) roll back everything → 503 UNAVAILABLE_PRE_COMMIT; no effect, no receipt, no EXECUTED audit', () => {
  for (const at of ['after-mutation', 'after-audit', 'before-commit'] as const) {
    const { db, done } = fresh();
    try {
      const { proposalId } = seedDeploy(db, S, NOW, 'canary');
      const auditBefore = auditLog(db, S.sessionId, S.runId).length;
      throwsHttp(() => execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW, { at, mode: 'throw' }), 503, /UNAVAILABLE_PRE_COMMIT/);
      assert.equal(generation(db), 88, at);
      assert.equal(count(db, 'SELECT count(*) n FROM receipts'), 0, at);
      assert.equal(auditLog(db, S.sessionId, S.runId).length, auditBefore, at);
      assert.equal(view(db, S, proposalId, NOW).status, 'OPEN');
      assert.ok(verifyChain(db, S.sessionId, S.runId).ok);
    } finally { done(); }
  }
});

test('post-commit fault → 500 UNCONFIRMED; retrying the same operation returns the committed receipt, effect applied once', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'canary');
    throwsHttp(() => execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW, { at: 'after-commit', mode: 'throw' }), 500, /UNCONFIRMED/);
    const r = execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW + 1) as any;
    assert.equal(r.status, 'SUCCEEDED');
    assert.equal(r.replayed, true);
    assert.equal(generation(db), 89);
  } finally { done(); }
});

test('crash injection (process exits mid-transaction) → after reopen: both-or-neither', () => {
  for (const [at, expectEffect] of [['after-mutation', false], ['after-audit', false], ['before-commit', false], ['after-commit', true]] as const) {
    const { file, db, done } = fresh();
    try {
      const { proposalId } = seedDeploy(db, S, NOW, 'canary');
      db.close();
      const res = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(CHILD), file, S.sessionId, S.runId, proposalId, '1', String(NOW), at, 'exit'], { encoding: 'utf8' });
      assert.equal(res.status, 86, `${at}: child should crash (stderr: ${res.stderr})`);
      const re = openDb(file);
      try {
        const receipts = count(re, 'SELECT count(*) n FROM receipts');
        const executed = auditLog(re, S.sessionId, S.runId).filter((r) => JSON.parse(r.envelope_json).type === 'EXECUTED').length;
        assert.equal(generation(re) === 89, expectEffect, `${at}: effect`);
        assert.equal(receipts, expectEffect ? 1 : 0, `${at}: receipt`);
        assert.equal(executed, expectEffect ? 1 : 0, `${at}: audit`);
        assert.ok(verifyChain(re, S.sessionId, S.runId).ok, `${at}: chain`);
        // and the system recovers: a retry either replays the receipt or executes exactly once
        const r = execute(re, S, proposalId, 1, 'agent:deploy-bot', NOW + 1) as any;
        assert.equal(r.status, 'SUCCEEDED');
        assert.equal(r.replayed, expectEffect);
        assert.equal(generation(re), 89);
      } finally { re.close(); }
    } finally { done(); }
  }
});

test('concurrency: 8 threads with separate SQLite connections execute the same operation → exactly 1 effect', async () => {
  const { file, db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'canary');
    db.close();
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<any>((resolve, reject) => {
      const w = new Worker(CHILD, { workerData: { db: file, ...S, proposalId, revision: 1, now: NOW } });
      w.once('message', resolve); w.once('error', reject);
    })));
    const re = openDb(file);
    try {
      assert.ok(results.every((r) => r.ok && r.status === 'SUCCEEDED'), JSON.stringify(results));
      assert.equal(results.filter((r) => r.replayed === false).length, 1, JSON.stringify(results));
      assert.equal(generation(re), 89);
      assert.equal(count(re, 'SELECT count(*) n FROM receipts'), 1);
      assert.ok(verifyChain(re, S.sessionId, S.runId).ok);
    } finally { re.close(); }
  } finally { done(); }
});

test('adapter failure inside execute → rolled back, 503, nothing applied (no fail-open)', async () => {
  const { DOMAINS } = await import('../src/domains.ts');
  const { db, done } = fresh();
  const orig = DOMAINS.deploy_release.apply;
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'canary');
    DOMAINS.deploy_release.apply = () => { throw new Error('simulated provider outage'); };
    throwsHttp(() => execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW), 503, /UNAVAILABLE_PRE_COMMIT/);
    assert.equal(count(db, 'SELECT count(*) n FROM receipts'), 0);
    assert.equal(generation(db), 88);
  } finally { DOMAINS.deploy_release.apply = orig; done(); }
});

// ---- Codex G2 regressions (decision-engine-planning/codex-sessions/gates/codex-g2-final.md) ----
test('G2-01 the clock is read inside the execution transaction; evidence that expired while waiting blocks execution', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'canary');
    let readInsideTx = false;
    const r = execute(db, S, proposalId, 1, 'agent:deploy-bot', () => { readInsideTx = db.isTransaction; return NOW + 5 * MIN; }) as any;
    assert.equal(readInsideTx, true);
    assert.equal(r.status, 'NOT_EXECUTED'); // telemetry published 1 min before NOW is stale at NOW+5min
    assert.ok(r.decision.obligations.some((g: any) => g.gateId === 'AVAIL(telemetry)'));
    assert.equal(generation(db), 88);
  } finally { done(); }
});

test('G2-02 an exception during COMMIT is UNCONFIRMED, never "nothing executed"; retry returns the receipt', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'canary');
    throwsHttp(() => execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW, { at: 'during-commit', mode: 'throw' }), 500, /UNCONFIRMED/);
    assert.equal(generation(db), 89);
    const r = execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW + 1) as any;
    assert.equal(r.replayed, true);
  } finally { done(); }
});

test('G2-03 a claimed fromArtifact that differs from the deployed artifact is refused; recovery proof binds the real one', () => {
  const { db, done } = fresh();
  try {
    seedDeploy(db, S, NOW, 'canary');
    const p = propose(db, S, { actionType: 'deploy_release', initiatingPrincipal: 'agent:deploy-bot', proposer: { kind: 'MANUAL' },
      params: { service: 'search-api', environment: 'prod', toArtifact: 'sha256:9f3c', fromArtifact: 'sha256:WRONG', trafficPercent: 1, intent: 'ROUTINE' } }, NOW);
    const d = view(db, S, p.proposalId, NOW).decision!;
    assert.equal(d.outcome, 'REFUSE');
    assert.ok(d.obligations.some((g) => g.reasonCode === 'FROM_ARTIFACT_MISMATCH'));
  } finally { done(); }
});

test('G2-04 re-seeding an existing session is refused (409); seeding is audited atomically', () => {
  const { db, done } = fresh();
  try {
    seedDeploy(db, S, NOW, 'canary');
    throwsHttp(() => seedDeploy(db, S, NOW, 'canary'), 409);
    assert.equal(auditLog(db, S.sessionId, S.runId).filter((r) => JSON.parse(r.envelope_json).type === 'WORLD_SEEDED').length, 1);
  } finally { done(); }
});

test('G2-05 replay detects a stored snapshot/decision that no longer matches its audit commitment', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'canary');
    const v = view(db, S, proposalId, NOW);
    assert.equal((replay(db, S, v.decisionId!) as any).identical, true);
    const row = db.prepare('SELECT snapshot_json FROM decisions WHERE decision_id=?').get(v.decisionId!) as { snapshot_json: string };
    db.prepare('UPDATE decisions SET snapshot_json=? WHERE decision_id=?').run(row.snapshot_json.replace('"PASS"', '"FAIL"'), v.decisionId!);
    assert.equal((replay(db, S, v.decisionId!) as any).reason, 'STORED_DECISION_DOES_NOT_MATCH_AUDIT');
  } finally { done(); }
});

test('G2-07 a receipt-id collision with another proposal is an integrity fault, never a foreign success', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'canary');
    const op = operationIdOf(S, proposalId, 1);
    db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?,?,?)').run(op, 'sess-other', S.runId, 'prop-other', 1, '{"forged":true}', NOW);
    throwsHttp(() => execute(db, S, proposalId, 1, 'agent:deploy-bot', NOW), 503, /integrity fault/);
    assert.throws(() => view(db, S, proposalId, NOW), /integrity fault/);
  } finally { done(); }
});

test('audit verification rejects a sequence gap', () => {
  const { db, done } = fresh();
  try {
    seedDeploy(db, S, NOW, 'canary');
    db.exec('DROP TRIGGER audit_no_delete');
    db.prepare('DELETE FROM audit WHERE seq=2').run();
    assert.equal(verifyChain(db, S.sessionId, S.runId).ok, false);
  } finally { done(); }
});

// ---- Codex G3-03 / G3-04 regressions (precise, store level) ----
import { review } from '../src/review.ts';
const telOf = (db: Db, svc: string, apm: number, syn: number | null, at: number) => tx(db, () => {
  const subject = { service: svc, env: 'prod', windowSec: 300 };
  publish(db, S, { kind: 'telemetry', sourceId: 'apm', sourceClass: 'ADAPTER', subject, value: { errorRatePct: apm, p95Ms: 310 } }, at);
  if (syn !== null) publish(db, S, { kind: 'telemetry', sourceId: 'synthetic', sourceClass: 'ADAPTER', subject, value: { errorRatePct: syn, p95Ms: 330 } }, at);
});

test('G3-03 an approval invalidated while APPROVE is BLOCKED stays dead after the world is restored', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'deploy-ready');
    const v = view(db, S, proposalId, NOW);
    assert.equal(v.decision!.outcome, 'ESCALATE');
    assert.equal(review(db, S, proposalId, 1, 'human:rhea', 'APPROVE', v.decision!.reviewToken, NOW).decision!.outcome, 'EXECUTE');
    const subj = { service: 'checkout-api', env: 'prod' };
    const st = readObs(db, S, 'deploy_state', 'deployer', subj)!.value;
    tx(db, () => publish(db, S, { kind: 'deploy_state', sourceId: 'deployer', sourceClass: 'ADAPTER', subject: subj, value: { ...st, lockHolder: 'deploy-7731' } }, NOW + 1));
    assert.equal(view(db, S, proposalId, NOW + 2).decision!.outcome, 'DEFER');
    tx(db, () => publish(db, S, { kind: 'deploy_state', sourceId: 'deployer', sourceClass: 'ADAPTER', subject: subj, value: st }, NOW + 3));
    const after = view(db, S, proposalId, NOW + 4).decision!;
    assert.equal(after.outcome, 'ESCALATE', 'the restored world needs a fresh approval');
    assert.equal(count(db, "SELECT count(*) n FROM approvals WHERE status='INVALIDATED'"), 1);
  } finally { done(); }
});

test('G3-04 a timer survives while its gate is BLOCKED; the original deadline still applies', () => {
  const { db, done } = fresh();
  try {
    const { proposalId } = seedDeploy(db, S, NOW, 'deploy-ready');
    telOf(db, 'checkout-api', 3.2, 3.2, NOW);
    const t0 = view(db, S, proposalId, NOW).decision!;
    assert.equal(t0.obligations.find((g) => g.gateId === 'D-TEL-HEALTH')!.deadlineAt, NOW + 15 * MIN);
    telOf(db, 'checkout-api', 3.2, 0.5, NOW + 10 * MIN); // sources now disagree → health BLOCKED
    const mid = view(db, S, proposalId, NOW + 10 * MIN).decision!;
    assert.equal(mid.gates.find((g) => g.gateId === 'D-TEL-HEALTH')!.status, 'BLOCKED');
    assert.equal(count(db, "SELECT count(*) n FROM gate_timers WHERE gate_id='D-TEL-HEALTH'"), 1, 'timer retained while BLOCKED');
    telOf(db, 'checkout-api', 3.2, 3.2, NOW + 16 * MIN); // agreeing red again, past the original deadline
    const late = view(db, S, proposalId, NOW + 16 * MIN).decision!;
    assert.equal(late.outcome, 'ESCALATE');
    assert.equal(late.obligations.find((g) => g.gateId === 'D-TEL-HEALTH')!.purpose, 'TIMEOUT');
  } finally { done(); }
});
