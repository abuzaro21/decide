// HTTP API against a real listening server and a real SQLite file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server.ts';

async function start(runId = 'run-test') {
  const dir = mkdtempSync(join(tmpdir(), 'decide-api-'));
  const app = createApp({ dbPath: join(dir, 'd.db'), runId });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { app, base, stop: () => new Promise<void>((r) => app.server.close(() => { app.close(); rmSync(dir, { recursive: true, force: true }); r(); })) };
}
async function client(base: string) {
  const r = await fetch(`${base}/api/session`, { method: 'POST' });
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const call = async (method: string, path: string, body?: unknown, c = cookie) => {
    const res = await fetch(base + path, { method, headers: { cookie: c, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  return { cookie, call };
}

test('API: canary scenario end to end, idempotent execute, receipt, audit verify, replay', async () => {
  const { base, stop } = await start();
  try {
    const { call } = await client(base);
    const { body: seeded } = await call('POST', '/api/scenarios/deploy-canary');
    const v = await call('GET', `/api/proposals/${seeded.proposalId}`);
    assert.equal(v.body.decision.outcome, 'EXECUTE');
    const e1 = await call('POST', `/api/proposals/${seeded.proposalId}/revisions/1/execute`);
    const e2 = await call('POST', `/api/proposals/${seeded.proposalId}/revisions/1/execute`);
    assert.equal(e1.body.status, 'SUCCEEDED');
    assert.equal(e2.body.replayed, true);
    assert.deepEqual(e2.body.receipt, e1.body.receipt);
    const op = await call('GET', `/api/operations/${e1.body.operationId}`);
    assert.deepEqual(op.body, e1.body.receipt);
    const a = await call('GET', '/api/audit');
    assert.equal(a.body.verify.ok, true);
    assert.equal(a.body.events.filter((x: any) => x.event.type === 'EXECUTED').length, 1);
    const head = a.body.verify.head;
    assert.equal((await call('POST', '/api/audit/verify', head)).body.ok, true);
    const rp = await call('POST', `/api/decisions/${e1.body.receipt.decisionId}/replay`);
    assert.equal(rp.body.identical, true);
  } finally { await stop(); }
});

test('API: Confidence Trap progresses only through world evidence; what-would-change is a preview', async () => {
  const { base, stop } = await start();
  try {
    const { call } = await client(base);
    const { body: { proposalId } } = await call('POST', '/api/scenarios/confidence-trap');
    let v = await call('GET', `/api/proposals/${proposalId}`);
    assert.equal(v.body.decision.outcome, 'DEFER');
    assert.equal(v.body.decision.display.agentConfidence.value, 0.99);
    const w = await call('GET', `/api/proposals/${proposalId}/what-would-change`);
    assert.equal(w.body.preview, true);
    assert.equal(w.body.combined.outcome, 'ESCALATE');
    v = await call('GET', `/api/proposals/${proposalId}`); // preview changed nothing
    assert.equal(v.body.decision.outcome, 'DEFER');
    await call('POST', `/api/proposals/${proposalId}/world`, { control: 'telemetry-healthy' });
    v = await call('POST', `/api/proposals/${proposalId}/world`, { control: 'drill-pass' });
    assert.equal(v.body.decision.outcome, 'ESCALATE');
    assert.equal(v.body.decision.obligations[0].required, 'release-owner');
    const ex = await call('POST', `/api/proposals/${proposalId}/revisions/1/execute`);
    assert.equal(ex.body.status, 'NOT_EXECUTED');
  } finally { await stop(); }
});

test('API: requester-asserted "apm" telemetry is stored as REQUESTER and satisfies nothing', async () => {
  const { base, stop } = await start();
  try {
    const { call } = await client(base);
    const { body: { proposalId } } = await call('POST', '/api/scenarios/confidence-trap');
    const v = await call('POST', `/api/proposals/${proposalId}/evidence`, { kind: 'telemetry', sourceId: 'apm', subject: { service: 'checkout-api', env: 'prod', windowSec: 300 }, value: { errorRatePct: 0, p95Ms: 1 } });
    assert.equal(v.body.decision.outcome, 'DEFER');
    assert.ok(v.body.decision.obligations.some((g: any) => g.gateId === 'AVAIL(telemetry)'));
    assert.ok(v.body.decision.rejected.some((r: any) => r.reason === 'SOURCE_NOT_ACCEPTED'));
  } finally { await stop(); }
});

test('API: strict ingress — unknown field / wrong type → 400; missing field → ASK', async () => {
  const { base, stop } = await start();
  try {
    const { call } = await client(base);
    await call('POST', '/api/scenarios/deploy-canary'); // seeds world so binding is possible
    const ok = { service: 'search-api', environment: 'prod', toArtifact: 'sha256:9f3c', fromArtifact: 'sha256:2134', intent: 'ROUTINE' };
    assert.equal((await call('POST', '/api/proposals', { actionType: 'deploy_release', params: { ...ok, trafficPercent: 1, sudo: true } })).status, 400);
    assert.equal((await call('POST', '/api/proposals', { actionType: 'deploy_release', params: { ...ok, trafficPercent: '1' } })).status, 400);
    assert.equal((await call('POST', '/api/proposals', { actionType: 'deploy_release', params: { ...ok, trafficPercent: 1.5 } })).status, 400);
    assert.equal((await call('POST', '/api/proposals', { actionType: 'deploy_release', params: ok, extra: 1 })).status, 400);
    const p = await call('POST', '/api/proposals', { actionType: 'deploy_release', params: ok, proposer: { kind: 'MANUAL', agentConfidence: 1 } });
    assert.equal(p.status, 200);
    const v = await call('GET', `/api/proposals/${p.body.proposalId}`);
    assert.equal(v.body.decision.outcome, 'ASK');
    assert.deepEqual(v.body.decision.obligations[0].required, ['trafficPercent']);
  } finally { await stop(); }
});

test('API: session isolation and run reset (old-run cookie → 410, foreign session → 404, no cookie → 401)', async () => {
  const { base, stop } = await start('run-new');
  try {
    const A = await client(base);
    const B = await client(base);
    const { body: { proposalId } } = await A.call('POST', '/api/scenarios/deploy-canary');
    const ex = await A.call('POST', `/api/proposals/${proposalId}/revisions/1/execute`);
    assert.equal((await B.call('GET', `/api/proposals/${proposalId}`)).status, 404);
    assert.equal((await B.call('POST', `/api/proposals/${proposalId}/revisions/1/execute`)).status, 404);
    assert.equal((await B.call('GET', `/api/operations/${ex.body.operationId}`)).status, 404);
    assert.equal((await B.call('POST', `/api/decisions/${ex.body.receipt.decisionId}/replay`)).status, 404);
    const stale = A.cookie.replace(/\.run-new$/, '.run-old').replace(/run-new/, 'run-old');
    assert.equal((await A.call('GET', `/api/proposals/${proposalId}`, undefined, stale)).status, 410);
    const anon = await fetch(`${base}/api/proposals/${proposalId}`);
    assert.equal(anon.status, 401);
  } finally { await stop(); }
});

test('G2-06 malformed URLs get a 400 and the server stays up; missing service reaches ASK (not 409)', async () => {
  const { base, stop } = await start();
  try {
    const { request } = await import('node:http');
    const u = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const r = request({ host: u.hostname, port: u.port, path: '/%', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode!); });
      r.on('error', reject); r.end();
    });
    assert.equal(status, 400);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const { call } = await client(base);
    await call('POST', '/api/scenarios/deploy-canary');
    const p = await call('POST', '/api/proposals', { actionType: 'deploy_release', params: { environment: 'prod', toArtifact: 'a', fromArtifact: 'b', trafficPercent: 1, intent: 'ROUTINE' } });
    assert.equal(p.status, 200);
    assert.equal((await call('GET', `/api/proposals/${p.body.proposalId}`)).body.decision.outcome, 'ASK');
  } finally { await stop(); }
});
