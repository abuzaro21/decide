// PAY / SUP golden fixtures (07 v2.1; vendor@cut1, support@v1). Pure evaluator, same engine as deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCore, approvalExpiry, MIN, HOUR, type Action, type Observation, type Snapshot, type Approval, type Policy } from '../src/engine.ts';
import { vendorPolicy, remitConflictDigest } from '../src/policy/vendor.ts';
import { supportPolicy, fraudDigest } from '../src/policy/support.ts';

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const META = { policyHash: 'test-policy', evaluatorVersion: 'test' };
const ROLES = { 'human:ana': ['ap-manager'], 'human:fin': ['finance-controller'], 'human:sec': ['security-lead'] };
const o = (kind: string, sourceId: string, subject: Observation['subject'], value: Observation['value'], ageMs = 0, rev = 1): Observation =>
  ({ kind, sourceId, sourceClass: 'ADAPTER', sourceRevision: rev, subject, value, observedAt: T0 - ageMs });
const run = (p: Policy, s: Snapshot) => evaluateCore(p, s, META);
const fails = (d: ReturnType<typeof run>) => d.obligations.map((g) => g.gateId).sort();
const blocked = (d: ReturnType<typeof run>) => d.later.map((g) => g.gateId).sort();
const swap = (s: Snapshot, kind: string, value: Record<string, unknown>, subject?: Observation['subject']) =>
  ({ ...s, candidates: s.candidates.map((x) => (x.kind === kind ? { ...x, value: { ...x.value, ...value }, ...(subject ? { subject } : {}), sourceRevision: x.sourceRevision + 1 } : x)) });
const drop = (s: Snapshot, kind: string) => ({ ...s, candidates: s.candidates.filter((x) => x.kind !== kind) });
function approve(p: Policy, s: Snapshot, approverId: string): Snapshot {
  const d = run(p, s);
  const ap: Approval = { approvalId: 'ap-1', revision: s.action.revision, fingerprint: d.fingerprint, ...META, snapshotRoot: d.snapshotRoot, preconditions: d.preconditions,
    reviewedRisk: d.risk!, requiredRole: p.requiredRole(d.risk!.tier)!, approverId, issuedAt: s.now, expiresAt: approvalExpiry(p, s, d), status: 'ACTIVE' };
  return { ...s, approvals: [...s.approvals, ap] };
}

// ---------- PAY-BASE ----------
const A = 'acct:7c1'; const B = 'acct:b44';
function payBase(over: { amountCents?: number; rail?: string; currency?: string; invoiceId?: string } = {}, world: { settled?: number; bank?: { v: number; acct: string; changedAt: number } } = {}): Snapshot {
  const bank = world.bank ?? { v: 3, acct: A, changedAt: T0 - 400 * 24 * HOUR };
  const params = { vendorId: 'northwind', invoiceId: 'INV-10422', amountCents: 80_000, currency: 'USD', rail: 'ACH', ...over };
  const action: Action = { schemaVersion: 1, sessionId: 's', runId: 'r', initiatingPrincipal: 'agent:ap-bot', proposalId: 'p', revision: 1, actionType: 'pay_vendor_invoice', params,
    expectedTargetVersions: { invoiceVersion: 1, bankDetailsVersion: bank.v, accountDigest: bank.acct }, recoveryScope: {} };
  const inv = { invoiceId: String(params.invoiceId) };
  return {
    action, now: T0, approvals: [], adjudications: [], timers: {}, roles: ROLES, agentConfidence: 0.97,
    candidates: [
      o('invoice_state', 'erp', inv, { version: 1, status: 'OPEN', openBalanceCents: 80_000, currency: 'USD' }),
      o('three_way_match', 'erp', { ...inv, invoiceVersion: 1 }, { status: 'MATCHED' }, HOUR),
      o('remit_to', 'erp', { ...inv, invoiceVersion: 1 }, { accountDigest: A }, HOUR),
      o('bank_details', 'vendor_master', { vendorId: 'northwind' }, { bankDetailsVersion: bank.v, accountDigest: bank.acct, changedAt: bank.changedAt, changeChannel: 'EMAIL' }),
      o('callback_verification', 'treasury', { vendorId: 'northwind', bankDetailsVersion: 3, accountDigest: A }, { status: 'PASS' }, 40 * 24 * HOUR),
      o('vendor_exposure', 'ledger', { vendorId: 'northwind', windowDays: 30 }, { settlements: world.settled ? [{ at: T0 - 24 * HOUR, cents: world.settled }] : [] }),
    ],
  };
}
const bec = () => payBase({}, { bank: { v: 4, acct: B, changedAt: T0 - 20 * HOUR } });

test('PAY-1 clean $800 ACH → EXECUTE, MEDIUM (I1·B1·U3)', () => {
  const d = run(vendorPolicy, payBase());
  assert.equal(d.outcome, 'EXECUTE');
  assert.deepEqual(d.risk, { I: 1, B: 1, U: 3, uUnknown: false, tier: 'MEDIUM' });
});

test('PAY-2 missing invoiceId → ASK; PAY-3 3-way PENDING → DEFER; PAY-7 settled → REFUSE; PAY-12 over balance → REFUSE', () => {
  const s2 = payBase(); delete (s2.action.params as any).invoiceId;
  assert.equal(run(vendorPolicy, s2).outcome, 'ASK');
  const d3 = run(vendorPolicy, swap(payBase(), 'three_way_match', { status: 'PENDING' }));
  assert.equal(d3.outcome, 'DEFER'); assert.deepEqual(fails(d3), ['P-3WAY-PENDING']);
  const d7 = run(vendorPolicy, swap(payBase(), 'invoice_state', { status: 'SETTLED' }));
  assert.equal(d7.outcome, 'REFUSE'); assert.deepEqual(fails(d7), ['P-DUP']);
  const d12 = run(vendorPolicy, payBase({ amountCents: 120_000 }));
  assert.equal(d12.outcome, 'REFUSE'); assert.ok(fails(d12).includes('P-OVER'));
});

test('PAY-4 BEC: master switched to account B by email 20 h ago, invoice says A → ESCALATE adjudicate + parallel callback obligation', () => {
  const d = run(vendorPolicy, bec());
  assert.equal(d.outcome, 'ESCALATE');
  assert.deepEqual(fails(d), ['AVAIL(callback_verification)', 'P-REMIT-CONFLICT']);
  assert.deepEqual(blocked(d), ['P-APPROVE', 'P-CALLBACK-BAD', 'P-CALLBACK-PENDING', 'P-COOLOFF']);
  assert.ok(d.rejected.some((r) => r.kind === 'callback_verification' && r.reason === 'SUBJECT_MISMATCH'), 'PAY-4b: callback for A never satisfies target B');
});

const adj = (decision: string, actor = 'human:ana') => ({ revision: 1, gateId: 'P-REMIT-CONFLICT', conflictDigest: remitConflictDigest(A, bec().action), decision, role: 'ap-manager', actor });
const withCallback = (s: Snapshot, status: string): Snapshot => ({ ...s, candidates: [...s.candidates, o('callback_verification', 'treasury', { vendorId: 'northwind', bankDetailsVersion: 4, accountDigest: B }, { status })] });

test('PAY-5 adjudicated PAY_BOUND_TARGET + callback PENDING → DEFER (callback + cool-off); PAY-6 vendor denies → REFUSE; PAY-6b REJECT → REFUSE', () => {
  const s5 = withCallback({ ...bec(), adjudications: [adj('PAY_BOUND_TARGET')] }, 'PENDING');
  const d5 = run(vendorPolicy, s5);
  assert.equal(d5.outcome, 'DEFER'); assert.deepEqual(fails(d5), ['P-CALLBACK-PENDING', 'P-COOLOFF']);
  const d6 = run(vendorPolicy, withCallback({ ...bec(), adjudications: [adj('PAY_BOUND_TARGET')] }, 'FAIL'));
  assert.equal(d6.outcome, 'REFUSE'); assert.deepEqual(fails(d6), ['P-CALLBACK-BAD', 'P-COOLOFF']);
  assert.equal(run(vendorPolicy, { ...bec(), adjudications: [adj('REJECT')] }).outcome, 'REFUSE');
  // an AP clerk without the role cannot adjudicate
  assert.equal(run(vendorPolicy, { ...bec(), adjudications: [adj('PAY_BOUND_TARGET', 'human:nobody')] }).outcome, 'ESCALATE');
  // cool-off elapses (48 h) but callback still required: aging never substitutes for verification (B-13)
  const later = { ...withCallback({ ...bec(), adjudications: [adj('PAY_BOUND_TARGET')] }, 'PENDING'), now: T0 + 30 * HOUR };
  const dl = run(vendorPolicy, { ...later, candidates: later.candidates.map((x) => ({ ...x, observedAt: Math.max(x.observedAt, T0) })) });
  assert.deepEqual(fails(dl), ['P-CALLBACK-PENDING']);
});

test('PAY-8 $48,200 wire → ESCALATE finance-controller (CRITICAL); PAY-9 sequential split escalates role at $25k cumulative', () => {
  const d8 = run(vendorPolicy, swap(payBase({ amountCents: 4_820_000, rail: 'WIRE' }), 'invoice_state', { openBalanceCents: 4_820_000 }));
  assert.equal(d8.outcome, 'ESCALATE'); assert.equal(d8.obligations[0].required, 'finance-controller');
  const tiers = [0, 900_000, 1_800_000].map((settled) => run(vendorPolicy, swap(payBase({ amountCents: 900_000 }, { settled }), 'invoice_state', { openBalanceCents: 900_000 })).risk!.tier);
  assert.deepEqual(tiers, ['HIGH', 'HIGH', 'CRITICAL']);
});

test('risk boundaries in cents: 99,999 / 100,000 / 2,499,999 / 2,500,000', () => {
  const tier = (amount: number) => run(vendorPolicy, swap(payBase({ amountCents: amount }), 'invoice_state', { openBalanceCents: amount })).risk!.tier;
  assert.deepEqual([99_999, 100_000, 2_499_999, 2_500_000].map(tier), ['MEDIUM', 'HIGH', 'HIGH', 'CRITICAL']);
});

test('PAY-11 approval invalidated when exposure grows within the same tier; PAY-14 low-risk payment with changed bank → STALE; PAY-15 EUR invoice → REFUSE', () => {
  const s = swap(payBase({ amountCents: 800_000 }), 'invoice_state', { openBalanceCents: 800_000 });
  const approved = approve(vendorPolicy, s, 'human:ana');
  assert.equal(run(vendorPolicy, approved).outcome, 'EXECUTE');
  const grown = swap(approved, 'vendor_exposure', { settlements: [{ at: T0 - HOUR, cents: 1_200_000 }] });
  const d11 = run(vendorPolicy, grown);
  assert.equal(d11.risk!.tier, 'HIGH');
  assert.equal(d11.outcome, 'ESCALATE');
  assert.match(JSON.stringify(d11.obligations[0].observed), /precondition changed/);
  const d14 = run(vendorPolicy, swap(payBase(), 'bank_details', { bankDetailsVersion: 4, accountDigest: B }));
  assert.equal(d14.outcome, 'REFUSE'); assert.ok(fails(d14).includes('VERSIONS'));
  const d15 = run(vendorPolicy, swap(payBase(), 'invoice_state', { currency: 'EUR' }));
  assert.equal(d15.outcome, 'REFUSE'); assert.deepEqual(fails(d15), ['P-CURRENCY']);
});

// ---------- SUP-BASE ----------
function supBase(over: { newEmail?: string } = {}, profile: Record<string, unknown> = {}): Snapshot {
  const params = { accountId: 'acct-55120', ticketId: 'T-58213', newEmail: 'new@example.com', ...over };
  const action: Action = { schemaVersion: 1, sessionId: 's', runId: 'r', initiatingPrincipal: 'agent:support-bot', proposalId: 'p', revision: 1, actionType: 'change_account_email', params,
    expectedTargetVersions: { accountVersion: 12, customerId: 'C-7781' }, recoveryScope: {} };
  return {
    action, now: T0, approvals: [], adjudications: [], timers: {}, roles: ROLES, agentConfidence: 0.97,
    candidates: [
      o('account_profile', 'crm', { accountId: 'acct-55120' }, { version: 12, tier: 'consumer', securityFlag: 'NONE', flagVersion: 0, customerId: 'C-7781', ...profile }),
      o('identity_verification', 'idv', { customerId: 'C-7781', accountId: 'acct-55120', ticketId: 'T-58213', newEmail: 'new@example.com' }, { status: 'PASS' }, 6 * MIN),
      o('credential_events', 'auth', { accountId: 'acct-55120' }, { lastCredentialChangeAt: null }),
      o('email_index', 'crm', { email: String(params.newEmail).toLowerCase() }, { ownerAccountId: null }),
    ],
  };
}

test('SUP-1 consumer, verified → EXECUTE (MEDIUM); SUP-6 org-admin → ESCALATE security-lead (HIGH)', () => {
  const d1 = run(supportPolicy, supBase());
  assert.equal(d1.outcome, 'EXECUTE'); assert.equal(d1.risk!.tier, 'MEDIUM');
  const d6 = run(supportPolicy, supBase({}, { tier: 'org-admin' }));
  assert.equal(d6.outcome, 'ESCALATE'); assert.deepEqual(fails(d6), ['S-APPROVE']); assert.equal(d6.risk!.tier, 'HIGH');
});

test('SUP IDV six states: missing/expired/wrong-destination → ASK, PENDING → DEFER, FAIL → REFUSE, PASS → EXECUTE', () => {
  const missing = run(supportPolicy, drop(supBase(), 'identity_verification'));
  assert.equal(missing.outcome, 'ASK'); assert.deepEqual(fails(missing), ['AVAIL(identity_verification)']);
  const expired = run(supportPolicy, { ...supBase(), candidates: supBase().candidates.map((x) => (x.kind === 'identity_verification' ? { ...x, observedAt: T0 - 45 * MIN } : x)) });
  assert.equal(expired.outcome, 'ASK');
  const swapped = supBase({ newEmail: 'attacker@example.net' });
  assert.equal(run(supportPolicy, swapped).outcome, 'ASK'); // SUP-10: verification bound to a different destination
  assert.equal(run(supportPolicy, swap(supBase(), 'identity_verification', { status: 'PENDING' })).outcome, 'DEFER');
  const failed = run(supportPolicy, swap(supBase(), 'identity_verification', { status: 'FAIL' }));
  assert.equal(failed.outcome, 'REFUSE'); assert.deepEqual(fails(failed), ['S-IDV-BAD']);
  assert.equal(run(supportPolicy, supBase()).outcome, 'EXECUTE');
});

test('SUP-5 recent password reset → DEFER (KR); SUP-7 email taken → REFUSE; SUP-11 fraud flag → ESCALATE, clear/reject; SUP-12 account changed → STALE', () => {
  const d5 = run(supportPolicy, swap(supBase(), 'credential_events', { lastCredentialChangeAt: T0 - 3 * HOUR }));
  assert.equal(d5.outcome, 'DEFER'); assert.equal(d5.obligations[0].deadlineAt, T0 + 21 * HOUR + 10 * MIN);
  assert.equal(run(supportPolicy, swap(supBase(), 'email_index', { ownerAccountId: 'acct-999' })).outcome, 'REFUSE');
  const flagged = supBase({}, { securityFlag: 'REVIEW', flagVersion: 7 });
  assert.equal(run(supportPolicy, flagged).outcome, 'ESCALATE');
  const clear = { revision: 1, gateId: 'S-FRAUD', conflictDigest: fraudDigest(7), decision: 'CLEAR_FOR_REVISION', role: 'security-lead', actor: 'human:sec' };
  assert.equal(run(supportPolicy, { ...flagged, adjudications: [clear] }).outcome, 'EXECUTE');
  assert.equal(run(supportPolicy, { ...flagged, adjudications: [{ ...clear, decision: 'REJECT' }] }).outcome, 'REFUSE');
  const reflagged = supBase({}, { securityFlag: 'REVIEW', flagVersion: 8 }); // new flag version re-opens the review
  assert.equal(run(supportPolicy, { ...reflagged, adjudications: [clear] }).outcome, 'ESCALATE');
  const d12 = run(supportPolicy, swap(supBase(), 'account_profile', { version: 13 }));
  assert.equal(d12.outcome, 'REFUSE'); assert.deepEqual(fails(d12), ['VERSIONS']);
});

test('SUP-8 prompt injection in ticket text + 1.0 self-confidence changes nothing vs SUP-3', () => {
  const base = drop(supBase(), 'identity_verification');
  const injected = { ...base, agentConfidence: 1, action: { ...base.action } };
  const a = run(supportPolicy, base); const b = run(supportPolicy, injected);
  assert.equal(b.outcome, 'ASK'); assert.deepEqual(b.gates, a.gates);
});

test('agent confidence invariance holds in vendor and support domains', () => {
  for (const [pol, snaps] of [[vendorPolicy, [payBase(), bec()]], [supportPolicy, [supBase(), drop(supBase(), 'identity_verification')]]] as const) {
    for (const s of snaps) {
      const ref = run(pol, { ...s, agentConfidence: 0.5 });
      for (const c of [0, 1, undefined]) { const d = run(pol, { ...s, agentConfidence: c }); assert.equal(d.outcome, ref.outcome); assert.deepEqual(d.gates, ref.gates); }
    }
  }
});

test('G4-01 a callback older than 90 days no longer verifies the payout target → DEFER', () => {
  const s = payBase();
  const old = { ...s, candidates: s.candidates.map((x) => (x.kind === 'callback_verification' ? { ...x, observedAt: T0 - 100 * 24 * HOUR } : x)) };
  const d = run(vendorPolicy, old);
  assert.equal(d.outcome, 'DEFER');
  assert.deepEqual(fails(d), ['AVAIL(callback_verification)']);
  assert.ok(d.rejected.some((r) => r.kind === 'callback_verification' && r.reason === 'EXPIRED'));
});

test('G4-02 exposure counts settlements in (now − 30 d, now] only', () => {
  const s = payBase({ amountCents: 20_000 });
  const at = (ageDays: number) => ({ ...s, candidates: s.candidates.map((x) => (x.kind === 'vendor_exposure' ? { ...x, value: { settlements: [{ at: T0 - ageDays * 24 * HOUR, cents: 80_000 }] } } : x)) });
  assert.equal(run(vendorPolicy, at(29)).risk!.I, 2); // 80,000 + 20,000 = 100,000 ⇒ HIGH band
  assert.equal(run(vendorPolicy, at(31)).risk!.I, 1); // old settlement outside the window
});
