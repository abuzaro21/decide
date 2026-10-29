// change_account_email policy — 06 §9 v2.1 (customer support domain).
import { approveGate, HOUR, MIN, type Action, type Policy } from '../engine.ts';
import { digest } from '../canonical.ts';

const p = (a: Action) => a.params as Record<string, any>;
export const canonicalEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();
export const fraudDigest = (flagVersion: unknown) => digest({ flagVersion });

export const supportPolicy: Policy = {
  name: 'support@v1',
  actionType: 'change_account_email',
  requiredFields: ['accountId', 'ticketId', 'newEmail'],
  evidence: [
    { kind: 'account_profile', sources: { crm: 'ADAPTER' }, fields: ['accountId'],
      subject: (a) => ({ accountId: String(p(a).accountId) }), freshness: { type: 'READ_CURRENT_STATE' }, binding: 'PRECONDITION', timeoutMs: 10 * MIN },
    // Customer ↔ account comes from the server-resolved binding, never from the caller (06 §6, R-11).
    { kind: 'identity_verification', sources: { idv: 'ADAPTER' }, fields: ['accountId', 'ticketId', 'newEmail'], availResolver: 'REQUESTER',
      subject: (a) => ({ customerId: String(a.expectedTargetVersions.customerId), accountId: String(p(a).accountId), ticketId: String(p(a).ticketId), newEmail: canonicalEmail(p(a).newEmail) }),
      freshness: { type: 'MAX_AGE', ms: 30 * MIN }, binding: 'SNAPSHOT', timeoutMs: 24 * HOUR, hypothetical: () => ({ status: 'PASS' }) },
    { kind: 'credential_events', sources: { auth: 'ADAPTER' }, fields: ['accountId'],
      subject: (a) => ({ accountId: String(p(a).accountId) }), freshness: { type: 'MAX_AGE', ms: 5 * MIN }, binding: 'SNAPSHOT', timeoutMs: 30 * MIN,
      hypothetical: () => ({ lastCredentialChangeAt: null }) },
    { kind: 'email_index', sources: { crm: 'ADAPTER' }, fields: ['newEmail'],
      subject: (a) => ({ email: canonicalEmail(p(a).newEmail) }), freshness: { type: 'READ_CURRENT_STATE' }, binding: 'PRECONDITION', timeoutMs: 10 * MIN },
  ],
  currentState: [{
    kind: 'account_profile',
    compare: (a, v) => [
      ...(v.version === a.expectedTargetVersions.accountVersion ? [] : [`accountVersion: expected ${a.expectedTargetVersions.accountVersion}, current ${v.version}`]),
      ...(v.customerId === a.expectedTargetVersions.customerId ? [] : ['account owner changed']),
    ],
  }],
  gates: [
    { id: 'S-EMAIL-TAKEN', resolver: 'NONE', reads: ['email_index'], eval: (c) => {
      const owner = c.val('email_index').ownerAccountId;
      return owner && owner !== c.params.accountId ? { status: 'FAIL', reasonCode: 'EMAIL_OWNED_BY_ANOTHER_ACCOUNT' } : { status: 'PASS' };
    } },
    { id: 'S-IDV-BAD', resolver: 'NONE', reads: ['identity_verification'], eval: (c) =>
      c.val('identity_verification').status === 'FAIL' ? { status: 'FAIL', reasonCode: 'IDENTITY_VERIFICATION_FAILED' } : { status: 'PASS' } },
    { id: 'S-IDV-PENDING', resolver: 'EXTERNAL', reads: ['identity_verification'], timeout: { type: 'OW', ms: 24 * HOUR },
      repair: { kind: 'identity_verification', value: { status: 'PASS' } }, eval: (c) =>
      c.val('identity_verification').status === 'PENDING' ? { status: 'FAIL', reasonCode: 'IDENTITY_VERIFICATION_PENDING' } : { status: 'PASS' } },
    { id: 'S-COOLDOWN', resolver: 'EXTERNAL', reads: ['credential_events'],
      timeout: { type: 'KR', releaseAt: (c) => Number(c.val('credential_events').lastCredentialChangeAt) + 24 * HOUR }, eval: (c) => {
      const at = c.val('credential_events').lastCredentialChangeAt;
      return at && at > c.snapshot.now - 24 * HOUR
        ? { status: 'FAIL', reasonCode: 'RECENT_CREDENTIAL_CHANGE', observed: { lastCredentialChangeAt: at }, required: 'no password/MFA change in the last 24 h' } : { status: 'PASS' };
    } },
    { id: 'S-FRAUD', resolver: 'AUTHORITY', purpose: 'ADJUDICATE', role: 'security-lead', reads: ['account_profile'], decisions: ['CLEAR_FOR_REVISION', 'REJECT'], eval: (c) => {
      const prof = c.val('account_profile');
      if (prof.securityFlag !== 'REVIEW') return { status: 'PASS' };
      const conflictDigest = fraudDigest(prof.flagVersion);
      const adj = c.adjudication('S-FRAUD', conflictDigest);
      if (adj?.decision === 'REJECT') return { status: 'FAIL', resolver: 'NONE', reasonCode: 'ADJUDICATION_REJECTED' };
      if (adj?.decision === 'CLEAR_FOR_REVISION') return { status: 'PASS', observed: `cleared flag version ${prof.flagVersion} for this revision` };
      return { status: 'FAIL', reasonCode: 'SECURITY_REVIEW_FLAG', observed: { conflictDigest, flagVersion: prof.flagVersion } };
    } },
    approveGate('S-APPROVE'),
  ],
  risk: (c) => {
    const tier = c.admitted.account_profile[0]?.value.tier;
    const I = tier === 'org-admin' ? 3 : tier === 'paid' ? 2 : tier === 'consumer' ? 1 : 3;
    return { I, B: tier === 'org-admin' ? 2 : 1, U: 2 };
  },
  requiredRole: (t) => (t === 'HIGH' || t === 'CRITICAL' ? 'security-lead' : null),
};
