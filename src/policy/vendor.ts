// pay_vendor_invoice policy — 06 §9 v2.1, reduced policy vendor@cut1 (P-WINDOW / payment_window cut, 13 §2).
import { approveGate, HOUR, MIN, type Action, type Ctx, type Policy } from '../engine.ts';
import { digest } from '../canonical.ts';

const p = (a: Action) => a.params as Record<string, any>;
export const CENTS_HIGH = 100_000; // $1,000.00
export const CENTS_CRITICAL = 2_500_000; // $25,000.00
const DAY = 24 * HOUR;

/** Payout target is server-resolved from the vendor master at proposal time and fingerprinted (06 §2, F-03). */
export const payoutTarget = (a: Action) => ({ bankDetailsVersion: a.expectedTargetVersions.bankDetailsVersion, accountDigest: String(a.expectedTargetVersions.accountDigest) });
export const remitConflictDigest = (remitTo: string, a: Action) => digest({ remitTo, target: payoutTarget(a) });

function exposureCents(c: Ctx): number {
  const settled = c.admitted.vendor_exposure[0]?.value.settledCents;
  const amount = c.params.amountCents;
  if (!Number.isSafeInteger(settled) || !Number.isSafeInteger(amount)) return Number.NaN;
  const total = settled + amount;
  if (!Number.isSafeInteger(total)) throw new Error('exposure overflow'); // checked arithmetic (06 §5)
  return total;
}

export const vendorPolicy: Policy = {
  name: 'vendor@cut1',
  actionType: 'pay_vendor_invoice',
  requiredFields: ['vendorId', 'invoiceId', 'amountCents', 'currency', 'rail'],
  evidence: [
    { kind: 'three_way_match', sources: { erp: 'ADAPTER' }, fields: ['invoiceId'],
      subject: (a) => ({ invoiceId: String(p(a).invoiceId), invoiceVersion: a.expectedTargetVersions.invoiceVersion }),
      freshness: { type: 'RESOURCE_VERSION_BOUND' }, binding: 'SNAPSHOT', timeoutMs: 7 * DAY, hypothetical: () => ({ status: 'MATCHED' }) },
    { kind: 'invoice_state', sources: { erp: 'ADAPTER' }, fields: ['invoiceId'],
      subject: (a) => ({ invoiceId: String(p(a).invoiceId) }), freshness: { type: 'READ_CURRENT_STATE' }, binding: 'PRECONDITION', timeoutMs: 10 * MIN },
    { kind: 'bank_details', sources: { vendor_master: 'ADAPTER' }, fields: ['vendorId'],
      subject: (a) => ({ vendorId: String(p(a).vendorId) }), freshness: { type: 'READ_CURRENT_STATE' }, binding: 'PRECONDITION', timeoutMs: 10 * MIN },
    { kind: 'remit_to', sources: { erp: 'ADAPTER' }, fields: ['invoiceId'],
      subject: (a) => ({ invoiceId: String(p(a).invoiceId), invoiceVersion: a.expectedTargetVersions.invoiceVersion }),
      freshness: { type: 'RESOURCE_VERSION_BOUND' }, binding: 'SNAPSHOT', timeoutMs: 10 * MIN },
    { kind: 'callback_verification', sources: { treasury: 'ADAPTER' }, fields: ['vendorId'],
      subject: (a) => ({ vendorId: String(p(a).vendorId), ...payoutTarget(a) }),
      freshness: { type: 'RESOURCE_VERSION_BOUND' }, binding: 'SNAPSHOT', timeoutMs: 72 * HOUR, hypothetical: () => ({ status: 'PASS' }) },
    { kind: 'vendor_exposure', sources: { ledger: 'ADAPTER' }, fields: ['vendorId'],
      subject: (a) => ({ vendorId: String(p(a).vendorId), windowDays: 30 }), freshness: { type: 'READ_CURRENT_STATE' }, binding: 'PRECONDITION', timeoutMs: 10 * MIN },
  ],
  currentState: [
    { kind: 'invoice_state', compare: (a, v) => (v.version === a.expectedTargetVersions.invoiceVersion ? [] : [`invoiceVersion: expected ${a.expectedTargetVersions.invoiceVersion}, current ${v.version}`]) },
    { kind: 'bank_details', compare: (a, v) => [
      ...(v.bankDetailsVersion === a.expectedTargetVersions.bankDetailsVersion ? [] : [`bankDetailsVersion: expected ${a.expectedTargetVersions.bankDetailsVersion}, current ${v.bankDetailsVersion}`]),
      ...(v.accountDigest === a.expectedTargetVersions.accountDigest ? [] : ['payout account changed in vendor master']),
    ] },
  ],
  gates: [
    { id: 'P-CURRENCY', resolver: 'NONE', reads: ['invoice_state'], eval: (c) =>
      c.params.currency === 'USD' && c.val('invoice_state').currency === 'USD' ? { status: 'PASS' }
        : { status: 'FAIL', reasonCode: 'CURRENCY_UNSUPPORTED', observed: { proposal: c.params.currency, invoice: c.val('invoice_state').currency }, required: 'USD on both' } },
    { id: 'P-RAIL', resolver: 'NONE', eval: (c) => (['ACH', 'WIRE'].includes(c.params.rail) ? { status: 'PASS' } : { status: 'FAIL', reasonCode: 'UNSUPPORTED_RAIL', observed: c.params.rail }) },
    { id: 'P-AMOUNT', resolver: 'NONE', eval: (c) => (Number.isSafeInteger(c.params.amountCents) && c.params.amountCents > 0 ? { status: 'PASS' } : { status: 'FAIL', reasonCode: 'INVALID_AMOUNT', observed: c.params.amountCents }) },
    { id: 'P-DUP', resolver: 'NONE', reads: ['invoice_state'], eval: (c) =>
      c.val('invoice_state').status === 'SETTLED' ? { status: 'FAIL', reasonCode: 'DUPLICATE_PAYMENT', observed: 'invoice already settled' } : { status: 'PASS' } },
    { id: 'P-OVER', resolver: 'NONE', reads: ['invoice_state'], dependsOn: ['P-AMOUNT'], eval: (c) =>
      c.params.amountCents > c.val('invoice_state').openBalanceCents
        ? { status: 'FAIL', reasonCode: 'OVER_OPEN_BALANCE', observed: c.params.amountCents, required: `≤ ${c.val('invoice_state').openBalanceCents}` } : { status: 'PASS' } },
    { id: 'P-3WAY-BAD', resolver: 'NONE', reads: ['three_way_match'], eval: (c) =>
      c.val('three_way_match').status === 'FAIL' ? { status: 'FAIL', reasonCode: 'THREE_WAY_MISMATCH' } : { status: 'PASS' } },
    { id: 'P-3WAY-PENDING', resolver: 'EXTERNAL', reads: ['three_way_match'], timeout: { type: 'OW', ms: 7 * DAY },
      repair: { kind: 'three_way_match', value: { status: 'MATCHED' } }, eval: (c) =>
      c.val('three_way_match').status === 'PENDING' ? { status: 'FAIL', reasonCode: 'THREE_WAY_PENDING' } : { status: 'PASS' } },
    { id: 'P-REMIT-CONFLICT', resolver: 'AUTHORITY', purpose: 'ADJUDICATE', role: 'ap-manager', reads: ['remit_to'], decisions: ['PAY_BOUND_TARGET', 'REJECT'], eval: (c) => {
      const remitTo = String(c.val('remit_to').accountDigest);
      const target = payoutTarget(c.action);
      if (remitTo === target.accountDigest) return { status: 'PASS' };
      const conflictDigest = remitConflictDigest(remitTo, c.action);
      const adj = c.adjudication('P-REMIT-CONFLICT', conflictDigest);
      if (adj?.decision === 'REJECT') return { status: 'FAIL', resolver: 'NONE', reasonCode: 'ADJUDICATION_REJECTED' };
      if (adj?.decision === 'PAY_BOUND_TARGET') return { status: 'PASS', observed: 'adjudicated: pay the fingerprinted vendor-master account' };
      return { status: 'FAIL', reasonCode: 'REMIT_TO_MISMATCH', observed: { conflictDigest, invoiceRemitTo: remitTo, payoutTarget: target } };
    } },
    { id: 'P-CALLBACK-BAD', resolver: 'NONE', reads: ['callback_verification'], dependsOn: ['P-REMIT-CONFLICT'], eval: (c) =>
      c.val('callback_verification').status === 'FAIL' ? { status: 'FAIL', reasonCode: 'CALLBACK_DENIED', observed: c.val('callback_verification') } : { status: 'PASS' } },
    { id: 'P-CALLBACK-PENDING', resolver: 'EXTERNAL', reads: ['callback_verification'], dependsOn: ['P-REMIT-CONFLICT'], timeout: { type: 'OW', ms: 72 * HOUR },
      repair: { kind: 'callback_verification', value: { status: 'PASS' } }, eval: (c) =>
      c.val('callback_verification').status === 'PENDING' ? { status: 'FAIL', reasonCode: 'CALLBACK_PENDING' } : { status: 'PASS' } },
    { id: 'P-COOLOFF', resolver: 'EXTERNAL', reads: ['bank_details'], dependsOn: ['P-REMIT-CONFLICT'],
      timeout: { type: 'KR', releaseAt: (c) => Number(c.val('bank_details').changedAt) + 48 * HOUR }, eval: (c) => {
      const changedAt = Number(c.val('bank_details').changedAt);
      return changedAt > c.snapshot.now - 48 * HOUR
        ? { status: 'FAIL', reasonCode: 'BANK_DETAILS_COOLOFF', observed: { changedAt, channel: c.val('bank_details').changeChannel }, required: 'bank details unchanged for 48 h' }
        : { status: 'PASS' };
    } },
    approveGate('P-APPROVE'),
  ],
  risk: (c) => {
    const e = exposureCents(c);
    const I = Number.isNaN(e) ? 3 : e < CENTS_HIGH ? 1 : e < CENTS_CRITICAL ? 2 : 3;
    return { I, B: 1, U: 3 }; // every settled payout is IRREVERSIBLE, either rail (06 §5)
  },
  requiredRole: (t) => (t === 'HIGH' ? 'ap-manager' : t === 'CRITICAL' ? 'finance-controller' : null),
};
