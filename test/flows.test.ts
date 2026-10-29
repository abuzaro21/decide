// G3/G4 end-to-end flows over HTTP: approvals, rejection, invalidation, adjudication, timeouts, three domains.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server.ts';

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'decide-flow-'));
  let now = T0;
  const app = createApp({ dbPath: join(dir, 'd.db'), runId: 'run-flow', clock: () => now });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const cookie = (await fetch(`${base}/api/session`, { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const scenario = async (id: string) => (await call('POST', `/api/scenarios/${id}`)).body.proposalId as string;
  const world = (pid: string, control: string) => call('POST', `/api/proposals/${pid}/world`, { control });
  const view = async (pid: string) => (await call('GET', `/api/proposals/${pid}`)).body;
  // Commands echo exactly what the human was shown (review token / conflict-or-timer episode), as the UI does.
  const reviewAs = async (pid: string, rev: number, approverId: string, verdict: string, token?: string) =>
    call('POST', `/api/proposals/${pid}/revisions/${rev}/review`, { approverId, verdict, reviewToken: token ?? (await view(pid)).decision.reviewToken });
  const episodeOf = (g: any) => (g.purpose === 'TIMEOUT' ? String(g.deadlineAt) : String(g.observed?.conflictDigest ?? ''));
  const adjudicate = async (pid: string, rev: number, actor: string, cmd: { gateId: string; reviewed?: string; [k: string]: unknown }) => {
    const g = (await view(pid)).decision.obligations.find((x: any) => x.gateId === cmd.gateId);
    return call('POST', `/api/proposals/${pid}/revisions/${rev}/adjudicate`, { actor, reviewed: cmd.reviewed ?? (g ? episodeOf(g) : 'none'), ...cmd });
  };
  const execute = (pid: string, rev: number) => call('POST', `/api/proposals/${pid}/revisions/${rev}/execute`);
  const events = async () => (await call('GET', '/api/audit')).body;
  return { app, call, scenario, world, view, reviewAs, adjudicate, episodeOf, execute, events, tick: (ms: number) => { now += ms; },
    stop: () => new Promise<void>((r) => app.server.close(() => { app.close(); rmSync(dir, { recursive: true, force: true }); r(); })) };
}

test('G3 Confidence Trap full sequence: DEFER → DEFER → ESCALATE → approve → EXECUTE → executed once; audit + replay hold', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('confidence-trap');
    assert.equal((await h.view(pid)).decision.outcome, 'DEFER');
    assert.equal((await h.reviewAs(pid, 1, 'human:omar', 'APPROVE')).status, 409, 'approval is not requestable while evidence is missing');
    assert.equal((await h.world(pid, 'telemetry-healthy')).body.decision.outcome, 'DEFER');
    const esc = (await h.world(pid, 'drill-pass')).body;
    assert.equal(esc.decision.outcome, 'ESCALATE');
    assert.equal((await h.reviewAs(pid, 1, 'human:sam', 'APPROVE')).status, 403, 'wrong role');
    const ok = await h.reviewAs(pid, 1, 'human:rhea', 'APPROVE');
    assert.equal(ok.body.decision.outcome, 'EXECUTE');
    const ex = await h.execute(pid, 1);
    assert.equal(ex.body.status, 'SUCCEEDED');
    assert.ok(ex.body.receipt.approvalId);
    const a = await h.events();
    assert.equal(a.verify.ok, true);
    const types = a.events.map((e: any) => e.event.type);
    for (const t of ['WORLD_SEEDED', 'PROPOSED', 'WORLD_EVENT', 'APPROVAL_GRANTED', 'EXECUTED']) assert.ok(types.includes(t), t);
    const replayed = await h.call('POST', `/api/decisions/${ex.body.receipt.decisionId}/replay`);
    assert.equal(replayed.body.identical, true);
  } finally { await h.stop(); }
});

test('G3 approval dies when the evidence changes (both monitors red) and when the artifact is swapped (new revision)', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('confidence-trap');
    await h.world(pid, 'telemetry-healthy'); await h.world(pid, 'drill-pass');
    await h.reviewAs(pid, 1, 'human:rhea', 'APPROVE');
    const red = (await h.world(pid, 'telemetry-red-both')).body;
    assert.equal(red.decision.outcome, 'DEFER');
    const notRun = await h.execute(pid, 1);
    assert.equal(notRun.body.status, 'NOT_EXECUTED');
    const back = (await h.world(pid, 'telemetry-healthy')).body;
    assert.equal(back.decision.outcome, 'ESCALATE', 'a recovered world still needs a NEW approval');
    assert.ok((await h.events()).events.some((e: any) => e.event.type === 'APPROVAL_INVALIDATED'));
    // swap the artifact: revision 2 supersedes, the (new) approval on rev 1 is invalidated
    await h.reviewAs(pid, 1, 'human:rhea', 'APPROVE');
    const v = await h.view(pid);
    const rev2 = await h.call('POST', `/api/proposals/${pid}/revisions`, { params: { ...v.action.params, toArtifact: 'sha256:a1e7' } });
    assert.equal(rev2.body.revision, 2);
    assert.equal((await h.execute(pid, 1)).status, 409);
    assert.equal((await h.view(pid)).decision.outcome, 'DEFER');
  } finally { await h.stop(); }
});

test('G3 reviewer rejection → REFUSE and the revision is closed', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('confidence-trap');
    await h.world(pid, 'telemetry-healthy'); await h.world(pid, 'drill-pass');
    const r = await h.reviewAs(pid, 1, 'human:rhea', 'REJECT');
    assert.equal(r.body.decision.outcome, 'REFUSE');
    assert.equal(r.body.status, 'CLOSED_REFUSED');
    assert.equal((await h.execute(pid, 1)).status, 409);
  } finally { await h.stop(); }
});

test('G3 adjudication: only the right role, only existing observations; timeout: extend once, then cancel only', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('confidence-trap');
    await h.world(pid, 'drill-pass');
    const both = (await h.world(pid, 'telemetry-healthy')).body; // both fresh healthy
    assert.equal(both.decision.outcome, 'ESCALATE');
    const split = (await h.world(pid, 'telemetry-red-apm')).body; // apm red, synthetic healthy → conflict
    const gate = split.decision.obligations.find((g: any) => g.gateId === 'D-TEL-CONFLICT');
    assert.ok(gate, JSON.stringify(split.decision.obligations));
    const red = gate.observed.candidates.find((x: any) => x.source === 'apm');
    assert.equal((await h.adjudicate(pid, 1, 'human:rhea', { gateId: 'D-TEL-CONFLICT', decision: 'SELECT_OBSERVATION', selection: red.observationId })).status, 403);
    assert.equal((await h.adjudicate(pid, 1, 'human:sam', { gateId: 'D-TEL-CONFLICT', decision: 'SELECT_OBSERVATION', selection: 'invented' })).status, 400);
    assert.equal((await h.adjudicate(pid, 1, 'human:sam', { gateId: 'D-TEL-CONFLICT', decision: 'MARK_HEALTHY' })).status, 400);
    const chose = await h.adjudicate(pid, 1, 'human:sam', { gateId: 'D-TEL-CONFLICT', decision: 'SELECT_OBSERVATION', selection: red.observationId });
    assert.equal(chose.body.decision.outcome, 'DEFER', 'trusting the red reading means waiting for recovery');

    const p2 = await (async () => { const h2 = await harness(); return h2; })();
    try {
      const t = await p2.scenario('confidence-trap');
      await p2.view(t);
      p2.tick(15 * 60_000);
      const due = await p2.view(t);
      assert.equal(due.decision.outcome, 'ESCALATE');
      const tg = due.decision.obligations.find((g: any) => g.purpose === 'TIMEOUT');
      assert.equal((await p2.adjudicate(t, 1, 'human:sam', { gateId: tg.gateId, decision: 'EXTEND_ONCE' })).status, 403);
      assert.equal((await p2.adjudicate(t, 1, 'human:op', { gateId: tg.gateId, decision: 'EXTEND_ONCE' })).body.decision.outcome, 'DEFER');
      p2.tick(15 * 60_000);
      const again = await p2.view(t);
      assert.equal(again.decision.outcome, 'ESCALATE');
      assert.equal((await p2.adjudicate(t, 1, 'human:op', { gateId: tg.gateId, decision: 'EXTEND_ONCE' })).status, 409, 'only one extension');
      const cancelled = await p2.adjudicate(t, 1, 'human:op', { gateId: tg.gateId, decision: 'CANCEL' });
      assert.equal(cancelled.body.decision.outcome, 'REFUSE');
    } finally { await p2.stop(); }
  } finally { await h.stop(); }
});

test('G4 vendor BEC with the genuine recorded proposal: adjudicate → callback pending → vendor denies → REFUSE; nothing paid', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('vendor-bec');
    const v = await h.view(pid);
    assert.equal(v.proposer.kind, 'RECORDED_LLM');
    assert.equal(v.proposer.model, 'claude-haiku-5-5');
    assert.equal(v.decision.outcome, 'ESCALATE');
    assert.equal((await h.reviewAs(pid, 1, 'human:ana', 'APPROVE')).status, 409, 'adjudication is not an approval');
    const a = await h.adjudicate(pid, 1, 'human:ana', { gateId: 'P-REMIT-CONFLICT', decision: 'PAY_BOUND_TARGET' });
    assert.equal(a.body.decision.outcome, 'DEFER');
    await h.world(pid, 'callback-started');
    const denied = (await h.world(pid, 'callback-denied')).body;
    assert.equal(denied.decision.outcome, 'REFUSE');
    assert.equal(denied.status, 'CLOSED_REFUSED');
    assert.equal((await h.execute(pid, 1)).status, 409);
  } finally { await h.stop(); }
});

test('G4 vendor clean: executes once, invoice settles; paying the same invoice again is a duplicate → REFUSE', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('vendor-clean');
    assert.equal((await h.view(pid)).decision.outcome, 'EXECUTE');
    const ex = await h.execute(pid, 1);
    assert.equal(ex.body.receipt.effect.effect, 'PAID');
    const again = await h.call('POST', '/api/proposals', { actionType: 'pay_vendor_invoice', params: { vendorId: 'northwind', invoiceId: 'INV-10422', amountCents: 80000, currency: 'USD', rail: 'ACH' } });
    const d = await h.view(again.body.proposalId);
    assert.equal(d.decision.outcome, 'REFUSE');
    assert.ok(d.decision.obligations.some((g: any) => g.reasonCode === 'DUPLICATE_PAYMENT'));
  } finally { await h.stop(); }
});

test('G4 support injection (genuine recording): ASK despite the injected "approval"; verification for this address → EXECUTE → email changed', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('support-injection');
    const v = await h.view(pid);
    assert.equal(v.proposer.kind, 'RECORDED_LLM');
    assert.match(v.proposer.prompt, /SYSTEM NOTE/);
    assert.equal(v.decision.outcome, 'ASK');
    assert.equal((await h.world(pid, 'idv-started')).body.decision.outcome, 'DEFER');
    assert.equal((await h.world(pid, 'idv-pass')).body.decision.outcome, 'EXECUTE');
    const ex = await h.execute(pid, 1);
    assert.equal(ex.body.receipt.effect.to, 'new@example.com');
  } finally { await h.stop(); }
});

test('G4 support org-admin: security-lead approval required; fraud flag after approval invalidates it and needs adjudication', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('support-org-admin');
    assert.equal((await h.view(pid)).decision.outcome, 'ESCALATE');
    assert.equal((await h.reviewAs(pid, 1, 'human:sec', 'APPROVE')).body.decision.outcome, 'EXECUTE');
    const flagged = (await h.world(pid, 'fraud-flag')).body;
    assert.equal(flagged.decision.outcome, 'ESCALATE');
    assert.ok(flagged.decision.obligations.some((g: any) => g.gateId === 'S-FRAUD'));
    const rej = await h.adjudicate(pid, 1, 'human:sec', { gateId: 'S-FRAUD', decision: 'REJECT' });
    assert.equal(rej.body.decision.outcome, 'REFUSE');
  } finally { await h.stop(); }
});

test('K-1 both monitors blind: the engine EXECUTES on fresh, agreeing, false evidence; ground truth is visible but never collected', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('both-monitors-blind');
    const v = await h.view(pid);
    assert.equal(v.decision.outcome, 'ESCALATE');
    assert.ok(!JSON.stringify(v.decision).includes('realUserErrorRatePct'), 'ground truth never reaches the evaluator');
    await h.reviewAs(pid, 1, 'human:rhea', 'APPROVE');
    assert.equal((await h.execute(pid, 1)).body.status, 'SUCCEEDED');
    const gt = await h.call('GET', '/api/ground-truth');
    assert.equal(gt.body[0].realUserErrorRatePct, 9);
  } finally { await h.stop(); }
});

test('recordings endpoint exposes genuine model outputs with model id; live agent route refuses without a key', async () => {
  const h = await harness();
  try {
    const recs = (await h.call('GET', '/api/recordings')).body;
    assert.ok(recs.length >= 3);
    assert.ok(recs.every((r: any) => r.model === 'claude-haiku-5-5' && r.rawOutput && r.recordedAt));
    const live = await h.call('POST', '/api/agent', { request: 'deploy something' });
    if (!process.env.ANTHROPIC_API_KEY) assert.equal(live.status, 503);
  } finally { await h.stop(); }
});

// ---- Codex G3/G4 regressions (decision-engine-planning/codex-sessions/gates/codex-g2r-g3-g4-final.md) ----
test('G3-01 a review command for a snapshot that changed since it was shown is refused (409 STALE_REVIEW)', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('confidence-trap');
    await h.world(pid, 'telemetry-healthy'); await h.world(pid, 'drill-pass');
    const shown = (await h.view(pid)).decision.reviewToken;
    await h.world(pid, 'telemetry-healthy'); // a new observation arrives after the reviewer looked
    const r = await h.reviewAs(pid, 1, 'human:rhea', 'APPROVE', shown);
    assert.equal(r.status, 409);
    assert.equal(r.body.status, 'STALE_REVIEW');
    assert.equal((await h.reviewAs(pid, 1, 'human:rhea', 'APPROVE')).body.decision.outcome, 'EXECUTE');
  } finally { await h.stop(); }
});

test('G3-02 replaying an adjudication command after the flag changed is refused (409 STALE_COMMAND)', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('support-org-admin');
    await h.world(pid, 'fraud-flag');
    const g1 = (await h.view(pid)).decision.obligations.find((x: any) => x.gateId === 'S-FRAUD');
    const seen = h.episodeOf(g1);
    assert.equal((await h.adjudicate(pid, 1, 'human:sec', { gateId: 'S-FRAUD', decision: 'CLEAR_FOR_REVISION', reviewed: seen })).status, 200);
    await h.world(pid, 'fraud-flag'); // flag version 2
    const replayed = await h.adjudicate(pid, 1, 'human:sec', { gateId: 'S-FRAUD', decision: 'CLEAR_FOR_REVISION', reviewed: seen });
    assert.equal(replayed.status, 409);
    assert.equal(replayed.body.status, 'STALE_COMMAND');
    assert.ok((await h.view(pid)).decision.obligations.some((x: any) => x.gateId === 'S-FRAUD'));
  } finally { await h.stop(); }
});

test('G4-02 exposure is a rolling 30-day window: after 31 days a new $200 invoice executes at MEDIUM', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('vendor-clean');
    assert.equal((await h.execute(pid, 1)).body.status, 'SUCCEEDED'); // $800 settled at t0
    h.tick(31 * 24 * 3600_000);
    const { publish } = await import('../src/world.ts');
    const { tx } = await import('../src/db.ts');
    const sess = (await h.call('GET', '/api/session')).body;
    const now = sess.now;
    tx(h.app.db, () => { // the simulated ERP issues a NEW invoice for the same vendor
      const S = { sessionId: sess.sessionId, runId: sess.runId };
      publish(h.app.db, S, { kind: 'invoice_state', sourceId: 'erp', sourceClass: 'ADAPTER', subject: { invoiceId: 'INV-10777' }, value: { version: 1, status: 'OPEN', openBalanceCents: 20_000, currency: 'USD' } }, now);
      publish(h.app.db, S, { kind: 'three_way_match', sourceId: 'erp', sourceClass: 'ADAPTER', subject: { invoiceId: 'INV-10777', invoiceVersion: 1 }, value: { status: 'MATCHED' } }, now);
      publish(h.app.db, S, { kind: 'remit_to', sourceId: 'erp', sourceClass: 'ADAPTER', subject: { invoiceId: 'INV-10777', invoiceVersion: 1 }, value: { accountDigest: 'acct:7c1-northwind-original' } }, now);
      publish(h.app.db, S, { kind: 'callback_verification', sourceId: 'treasury', sourceClass: 'ADAPTER', subject: { vendorId: 'northwind', bankDetailsVersion: 3, accountDigest: 'acct:7c1-northwind-original' }, value: { status: 'PASS' } }, now);
    });
    const r = await h.call('POST', '/api/proposals', { actionType: 'pay_vendor_invoice', params: { vendorId: 'northwind', invoiceId: 'INV-10777', amountCents: 20000, currency: 'USD', rail: 'ACH' } });
    const d = (await h.view(r.body.proposalId)).decision;
    assert.equal(d.risk.I, 1, 'the $800 from 31 days ago is outside the window');
    assert.equal(d.outcome, 'EXECUTE');
    assert.equal((await h.execute(r.body.proposalId, 1)).body.status, 'SUCCEEDED');
  } finally { await h.stop(); }
});

test('G4-03 changing an email to its current address keeps ownership in the index', async () => {
  const h = await harness();
  try {
    const pid = await h.scenario('support-injection');
    await h.world(pid, 'idv-pass');
    await h.execute(pid, 1);
    const p2 = await h.call('POST', '/api/proposals', { actionType: 'change_account_email', params: { accountId: 'acct-55120', ticketId: 'T-58213', newEmail: 'new@example.com' } });
    await h.world(p2.body.proposalId, 'idv-pass');
    assert.equal((await h.execute(p2.body.proposalId, 1)).body.status, 'SUCCEEDED');
    const sess = (await h.call('GET', '/api/session')).body;
    const { readObs } = await import('../src/world.ts');
    const idx = readObs(h.app.db, { sessionId: sess.sessionId, runId: sess.runId }, 'email_index', 'crm', { email: 'new@example.com' });
    assert.equal(idx!.value.ownerAccountId, 'acct-55120');
  } finally { await h.stop(); }
});

test('client-submitted proposals cannot claim model provenance', async () => {
  const h = await harness();
  try {
    await h.scenario('deploy-canary');
    const r = await h.call('POST', '/api/proposals', { actionType: 'deploy_release', params: { service: 'search-api', environment: 'prod' }, proposer: { kind: 'RECORDED_LLM', model: 'gpt-imaginary' } });
    assert.equal(r.status, 400);
  } finally { await h.stop(); }
});
