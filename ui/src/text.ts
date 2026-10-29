// Wording only. The UI never decides anything; it explains the engine's decision record.
import type { Decision, Gate, View } from './api';

export const OUTCOME_COPY: Record<Decision['outcome'], { verb: string; next: string }> = {
  EXECUTE: { verb: 'Execute', next: 'Every gate passes. Execution re-checks everything inside one transaction.' },
  ASK: { verb: 'Ask', next: 'The requester must supply something before anything else can happen.' },
  DEFER: { verb: 'Defer', next: 'Waiting on an external system or the clock. Nobody needs to approve anything yet.' },
  ESCALATE: { verb: 'Escalate', next: 'A named human role must decide. Nothing runs until they do.' },
  REFUSE: { verb: 'Refuse', next: 'Closed. No evidence, time or approval can rescue this revision. Only a new proposal can proceed.' },
};

export const EVIDENCE_LABEL: Record<string, string> = {
  telemetry: 'health telemetry', ci_result: 'CI result', rollback_drill: 'rollback drill', migration_class: 'migration classification', deploy_state: 'current deployment state',
  three_way_match: 'three-way match', invoice_state: 'invoice state', bank_details: 'vendor bank details', remit_to: 'invoice remit-to account',
  callback_verification: 'callback verification', vendor_exposure: '30-day vendor exposure',
  account_profile: 'account profile', identity_verification: 'identity verification', credential_events: 'credential activity', email_index: 'email ownership index',
};
const SOURCE_OF: Record<string, string> = {
  telemetry: 'Monitoring', ci_result: 'CI', rollback_drill: 'CI', migration_class: 'CI', deploy_state: 'Deployer',
  three_way_match: 'ERP', invoice_state: 'ERP', remit_to: 'ERP', bank_details: 'Vendor master', callback_verification: 'Treasury', vendor_exposure: 'Ledger',
  account_profile: 'CRM', identity_verification: 'Customer', credential_events: 'Auth service', email_index: 'CRM',
};
const ROLE_LABEL: Record<string, string> = {
  'release-owner': 'Release owner', 'eng-director': 'Engineering director', 'sre-oncall': 'SRE on-call', operator: 'Operator',
  'ap-manager': 'AP manager', 'finance-controller': 'Finance controller', 'security-lead': 'Security lead',
};
export const roleLabel = (r?: string) => (r ? ROLE_LABEL[r] ?? r : '');
const kindOf = (g: Gate) => (g.gateId.startsWith('AVAIL(') ? g.gateId.slice(6, -1) : '');

/** Who must act to clear this gate. */
export function actorOf(g: Gate): string {
  if (g.purpose === 'TIMEOUT') return 'Operator';
  if (g.resolver === 'AUTHORITY') return roleLabel(g.role ?? (typeof g.required === 'string' ? g.required : ''));
  if (g.resolver === 'REQUESTER') return kindOf(g) === 'identity_verification' ? 'The customer' : 'Requester (the agent)';
  if (g.resolver === 'NONE') return 'Nobody';
  const k = kindOf(g);
  if (k) return SOURCE_OF[k] ?? 'External system';
  if (g.gateId.includes('TEL')) return 'Monitoring';
  if (g.gateId.includes('CI') || g.gateId.includes('DRILL')) return 'CI';
  if (g.gateId.includes('LOCK')) return 'Deployer';
  if (g.gateId.includes('CALLBACK')) return 'Treasury';
  if (g.gateId.includes('COOLOFF') || g.gateId.includes('COOLDOWN')) return 'The clock';
  if (g.gateId.includes('3WAY')) return 'ERP';
  if (g.gateId.includes('IDV')) return 'Identity verification';
  return 'External system';
}

const pct = (x: unknown) => (typeof x === 'number' ? `${x}%` : '?');

/** One plain sentence per open gate. */
export function sentence(g: Gate, v?: View): string {
  const k = kindOf(g);
  const code = (g.reasonCode ?? '').replace(/^TIMEOUT:/, '');
  if (g.purpose === 'TIMEOUT') return `Waited past the deadline for ${k ? EVIDENCE_LABEL[k] ?? k : g.gateId}. An operator must cancel or extend once — they cannot make the evidence appear.`;
  switch (code) {
    case 'EVIDENCE_UNAVAILABLE': return `No acceptable ${EVIDENCE_LABEL[k] ?? k}: it is missing, too old, about something else, or from a source not trusted for it.`;
    case 'MISSING_FIELDS': return `The proposal is missing ${(g.required as string[]).join(', ')}.`;
    case 'APPROVAL_REQUIRED': return `Risk is ${v?.decision?.risk?.tier ?? 'high'}: the ${roleLabel(String(g.required)).toLowerCase()} must approve this exact action and evidence snapshot.`;
    case 'APPROVAL_REJECTED': return 'A reviewer rejected this revision.';
    case 'TELEMETRY_SOURCES_DISAGREE': return 'The two monitors disagree about health. Someone accountable must decide which reading to trust; neither wins by rank.';
    case 'TELEMETRY_UNHEALTHY': return `Production is unhealthy right now (${pct(g.observed?.errorRatePct)} errors, p95 ${g.observed?.p95Ms ?? '?'} ms). Limit: under 2% and under 800 ms.`;
    case 'ROLLBACK_DRILL_FAILED': return 'The rollback drill for this exact release pair failed. A reviewer cannot approve a demonstrated rollback failure.';
    case 'ROLLBACK_DRILL_PENDING': return 'The rollback drill for this release pair is still running.';
    case 'CI_FAILED': return 'CI failed for this artifact.';
    case 'CI_PENDING': return 'CI has not finished for this artifact.';
    case 'DESTRUCTIVE_MIGRATION': return 'This release carries a destructive migration. This channel never ships those.';
    case 'DEPLOY_LOCK_HELD': return `Another deploy (${g.observed}) holds the deploy lock.`;
    case 'STALE_PROPOSAL': return `The world changed since this was proposed (${(g.observed as string[]).join('; ')}). Re-propose against current state.`;
    case 'UNSUPPORTED_PATH': return 'Labelled as incident remediation. This channel ships routine releases only and never waives the health gate.';
    case 'UNSUPPORTED_TARGET': return 'Unknown service, environment or traffic value.';
    case 'UNSUPPORTED_ACTION': return 'This action type is not covered by any policy.';
    case 'ADJUDICATION_REJECTED': return 'The adjudicator rejected this revision.';
    case 'FROM_ARTIFACT_MISMATCH': return `The agent claims it is replacing ${g.observed}, but ${String(g.required).replace(/^the artifact actually deployed: /, '')} is what is actually deployed. Recovery proof must cover the real starting point.`;
    case 'CURRENCY_UNSUPPORTED': return `Currency mismatch or unsupported (proposal ${g.observed?.proposal}, invoice ${g.observed?.invoice}). Only USD-to-USD is supported.`;
    case 'UNSUPPORTED_RAIL': return `Unknown payment rail ${g.observed}.`;
    case 'INVALID_AMOUNT': return 'The amount is not a positive whole number of cents.';
    case 'DUPLICATE_PAYMENT': return 'This invoice is already settled. Paying it again would be a duplicate payment.';
    case 'OVER_OPEN_BALANCE': return `The amount exceeds what is still owed on the invoice (${g.required}).`;
    case 'THREE_WAY_MISMATCH': return 'Purchase order, goods receipt and invoice do not match.';
    case 'THREE_WAY_PENDING': return 'The goods receipt is not posted yet, so the invoice cannot be matched.';
    case 'REMIT_TO_MISMATCH': return 'The invoice asks for payment to one account; the vendor master now holds a different one. An AP manager must decide which is authoritative. The payee cannot be changed by that decision.';
    case 'CALLBACK_PENDING': return 'Treasury is calling the vendor on the number on file to confirm the bank change.';
    case 'CALLBACK_DENIED': return 'On the callback, the vendor said they never changed their bank details. This is business-email-compromise fraud; no one can approve paying it.';
    case 'BANK_DETAILS_COOLOFF': return `The bank details changed less than 48 hours ago (via ${g.observed?.channel}). Waiting is a separate requirement from verification; it never replaces it.`;
    case 'EMAIL_OWNED_BY_ANOTHER_ACCOUNT': return 'That email address already belongs to a different account.';
    case 'IDENTITY_VERIFICATION_PENDING': return 'The customer has started identity verification but it has not finished.';
    case 'IDENTITY_VERIFICATION_FAILED': return 'Identity verification failed. Changing the login email now would hand the account to whoever asked.';
    case 'RECENT_CREDENTIAL_CHANGE': return 'The password or MFA changed in the last 24 hours, a classic account-takeover pattern. Waiting out the cool-down.';
    case 'SECURITY_REVIEW_FLAG': return 'The risk engine flagged this account. A security lead must clear this exact flag or reject the request.';
    case 'CANCELLED_BY_OPERATOR': return 'An operator cancelled this revision after its deadline.';
    default: return `${g.gateId}: ${g.reasonCode ?? 'blocked'}`;
  }
}

export const SUPPORT_COPY: Record<string, string> = {
  COMPLETE: 'All required evidence present and uncontested',
  INCOMPLETE: 'Some required evidence is missing or stale',
  CONTESTED: 'Trusted sources disagree',
  ADVERSE: 'Evidence shows a verified failure',
  NOT_EVALUATED: 'Proposal incomplete — evidence not evaluated',
};

export function costOfBeingWrong(v: View): string {
  const p = v.action.params;
  if (v.action.actionType === 'deploy_release') return `${p.trafficPercent ?? '?'}% of ${p.service ?? '?'} ${p.environment ?? ''} traffic`;
  if (v.action.actionType === 'pay_vendor_invoice') return `$${((p.amountCents ?? 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${p.rail === 'WIRE' ? 'by wire — irreversible' : 'by ACH — irreversible once settled'}`;
  if (v.action.actionType === 'change_account_email') return 'Account takeover, or locking the real owner out';
  return '—';
}

export function actionTitle(v: View): string {
  const p = v.action.params;
  switch (v.action.actionType) {
    case 'deploy_release': return `Deploy ${p.service ?? '?'} ${short(p.toArtifact)} to ${p.environment ?? '?'} · ${p.trafficPercent ?? '?'}% traffic`;
    case 'pay_vendor_invoice': return `Pay ${p.vendorId ?? '?'} invoice ${p.invoiceId ?? '?'} · $${((p.amountCents ?? 0) / 100).toFixed(2)} ${p.rail ?? ''}`;
    case 'change_account_email': return `Change email on ${p.accountId ?? '?'} to ${p.newEmail ?? '?'}`;
    default: return v.action.actionType;
  }
}
export const short = (x: unknown) => (typeof x === 'string' && x.length > 14 ? `${x.slice(0, 12)}…` : String(x ?? '?'));
