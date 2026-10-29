// DECIDE core evaluator. Pure and deterministic: no I/O, no clock, no randomness.
// Normative spec: decision-engine-planning/06-DECISION-SEMANTICS-AND-POLICY-MODEL.md (v2.1).
import { digest } from './canonical.ts';

export type Outcome = 'EXECUTE' | 'ASK' | 'DEFER' | 'ESCALATE' | 'REFUSE';
export type Resolver = 'REQUESTER' | 'EXTERNAL' | 'AUTHORITY' | 'NONE';
export type Status = 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'BLOCKED';
export type Purpose = 'ADJUDICATE' | 'APPROVE' | 'TIMEOUT';
export type SourceClass = 'ADAPTER' | 'REVIEWER' | 'REQUESTER' | 'HYPOTHETICAL';
export type Tier = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Mode = 'LIVE' | 'PREVIEW';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
const SKEW_MS = 5_000;
const KR_GRACE_MS = 10 * MIN;

export interface Action {
  schemaVersion: 1;
  sessionId: string;
  runId: string;
  initiatingPrincipal: string;
  proposalId: string;
  revision: number;
  actionType: string;
  params: Record<string, unknown>;
  expectedTargetVersions: Record<string, string | number>;
  recoveryScope: Record<string, string | number>;
}

export interface Observation {
  kind: string;
  sourceId: string;
  sourceClass: SourceClass;
  sourceRevision: number;
  subject: Record<string, string | number>;
  value: Record<string, unknown>;
  observedAt: number;
}

export interface Approval {
  approvalId: string;
  revision: number;
  fingerprint: string;
  policyHash: string;
  evaluatorVersion: string;
  snapshotRoot: string;
  preconditions: Record<string, string>;
  reviewedRisk: Risk;
  requiredRole: string;
  approverId: string;
  issuedAt: number;
  expiresAt: number;
  status: 'ACTIVE' | 'CONSUMED' | 'INVALIDATED' | 'REJECTED';
  hypothetical?: true;
}

export interface Adjudication {
  revision: number;
  gateId: string;
  conflictDigest: string;
  decision: string; // per-gate allowed decisions, 06 §7.1
  selection?: string; // observation id for SELECT_OBSERVATION
  role: string;
  actor: string;
}

export interface Timer { firstBlockedAt: number; deadlineAt: number; extended: boolean }

export interface Snapshot {
  action: Action;
  candidates: Observation[];
  approvals: Approval[];
  adjudications: Adjudication[];
  timers: Record<string, Timer>;
  roles: Record<string, string[]>; // principal -> roles, server-owned
  now: number;
  agentConfidence?: number; // displayed only; never read by any gate
}

export type Freshness =
  | { type: 'MAX_AGE'; ms: number }
  | { type: 'DIGEST_BOUND' | 'RESOURCE_VERSION_BOUND' | 'REVISION_BOUND' | 'READ_CURRENT_STATE' };

export interface EvidenceKind {
  kind: string;
  sources: Record<string, SourceClass>; // accepted sourceId -> required class; first key = highest rank
  subject: (a: Action) => Record<string, string | number>;
  freshness: Freshness;
  binding: 'SNAPSHOT' | 'PRECONDITION';
  availResolver?: Resolver; // default EXTERNAL
  timeoutMs: number; // OW deadline for AVAIL(kind)
  fields: string[]; // params the subject reads
  hypothetical?: (a: Action) => Record<string, unknown>; // value used by "what would change"
}

export type Timeout = { type: 'OW' | 'RW'; ms: number } | { type: 'KR'; releaseAt: (c: Ctx) => number };

export interface GateResultCore {
  status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
  reasonCode?: string;
  observed?: unknown;
  required?: unknown;
  resolver?: Resolver; // override for this result (e.g. adjudication REJECT -> NONE)
}

export interface GateDef {
  id: string;
  resolver: Resolver;
  purpose?: Purpose;
  role?: string;
  reads?: string[]; // evidence kinds -> implicit dependsOn AVAIL(kind)
  dependsOn?: string[];
  timeout?: Timeout;
  repair?: { kind: string; value: Record<string, unknown> } | { approval: true };
  decisions?: string[]; // typed adjudication decisions this gate accepts (06 §7.1)
  eval: (c: Ctx) => GateResultCore;
}

export interface Risk { I: number; B: number; U: number; uUnknown: boolean; tier: Tier }

export interface Policy {
  name: string;
  actionType: string;
  requiredFields: string[];
  evidence: EvidenceKind[];
  gates: GateDef[];
  risk: (c: Ctx) => { I: number; B: number; U: number | 'UNKNOWN' };
  requiredRole: (tier: Tier) => string | null;
  currentState: { kind: string; compare: (a: Action, v: Record<string, unknown>) => string[] }[];
}

export interface Ctx {
  action: Action;
  params: Record<string, any>;
  admitted: Record<string, Observation[]>; // kind -> one observation per source, rank order
  one: (kind: string) => Observation; // highest-ranked admitted observation
  val: (kind: string) => Record<string, any>;
  adjudication: (gateId: string, conflictDigest: string) => Adjudication | undefined;
  risk: () => Risk;
  snapshot: Snapshot;
  policy: Policy;
  mode: Mode;
  meta: Meta;
}

export interface Meta { policyHash: string; evaluatorVersion: string }

export interface GateResult {
  gateId: string;
  status: Status;
  resolver?: Resolver;
  purpose?: Purpose;
  role?: string;
  dependsOn: string[];
  blockedBy?: string[];
  reasonCode?: string;
  observed?: unknown;
  required?: unknown;
  deadlineAt?: number;
}

export interface Rejection { observationId: string; kind: string; sourceId: string; reason: string }

export interface Decision {
  outcome: Outcome;
  fingerprint: string;
  policyName: string;
  policyHash: string;
  evaluatorVersion: string;
  gates: GateResult[];
  obligations: GateResult[];
  later: GateResult[];
  rejected: Rejection[];
  admittedIds: string[];
  snapshotRoot: string;
  preconditions: Record<string, string>;
  risk: Risk | null;
  display: Display;
  timerUpdates: Record<string, Timer>;
  mode: Mode;
}

export interface Display {
  agentConfidence: { value: number | null; label: string };
  evidenceCoverage: { available: number; required: number };
  provenance: { adapter: number; reviewer: number; requester: number; rejected: number };
  evidenceSupport: 'COMPLETE' | 'INCOMPLETE' | 'CONTESTED' | 'ADVERSE' | 'NOT_EVALUATED';
  riskScore: { ordinal: number; of: 4; tier: Tier; components: string } | null;
}

export const TIERS: Tier[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
// 06 §5 matrix: rows C = max(I,B), columns U.
const MATRIX: Tier[][] = [
  ['LOW', 'LOW', 'LOW', 'LOW'],
  ['LOW', 'LOW', 'MEDIUM', 'MEDIUM'],
  ['MEDIUM', 'MEDIUM', 'HIGH', 'HIGH'],
  ['HIGH', 'HIGH', 'HIGH', 'CRITICAL'],
];
export function tierOf(I: number, B: number, U: number): Tier {
  for (const x of [I, B, U]) if (!Number.isInteger(x) || x < 0 || x > 3) throw new Error(`risk component out of range: ${x}`);
  return MATRIX[Math.max(I, B)][U];
}

export const observationId = (o: Observation) =>
  digest({ sourceId: o.sourceId, kind: o.kind, subject: o.subject, sourceRevision: o.sourceRevision });

export function fingerprint(a: Action): string {
  return digest({
    schemaVersion: a.schemaVersion, sessionId: a.sessionId, runId: a.runId, initiatingPrincipal: a.initiatingPrincipal,
    proposalId: a.proposalId, revision: a.revision, actionType: a.actionType, params: a.params,
    expectedTargetVersions: a.expectedTargetVersions, recoveryScope: a.recoveryScope,
  });
}

const availId = (kind: string) => `AVAIL(${kind})`;
const CORE = ['CONTRACT', 'FIELDS', 'VERSIONS'];

/** Expand implicit dependencies and validate a policy (06 §3 "Policy load validation"). Throws on invalid policy. */
export function expandPolicy(p: Policy): Map<string, GateDef & { deps: string[] }> {
  const kinds = new Set(p.evidence.map((e) => e.kind));
  const all = new Map<string, GateDef & { deps: string[] }>();
  const add = (g: GateDef, deps: string[]) => {
    if (all.has(g.id)) throw new Error(`policy ${p.name}: duplicate gate id ${g.id}`);
    all.set(g.id, { ...g, deps });
  };
  for (const e of p.evidence) {
    if (!e.timeoutMs || Object.keys(e.sources).length === 0) throw new Error(`policy ${p.name}: evidence ${e.kind} lacks timeout or sources`);
    add({ id: availId(e.kind), resolver: e.availResolver ?? 'EXTERNAL', timeout: { type: 'OW', ms: e.timeoutMs }, eval: () => ({ status: 'PASS' }) }, ['FIELDS']);
  }
  const approve = p.gates.filter((g) => g.purpose === 'APPROVE');
  if (approve.length > 1) throw new Error(`policy ${p.name}: more than one APPROVE gate`);
  for (const g of p.gates) {
    for (const k of g.reads ?? []) if (!kinds.has(k)) throw new Error(`policy ${p.name}: gate ${g.id} reads unknown evidence ${k}`);
    if (g.repair && 'kind' in g.repair && g.resolver !== 'EXTERNAL' && g.resolver !== 'REQUESTER') throw new Error(`policy ${p.name}: gate ${g.id} evidence repair on ${g.resolver} resolver`);
    if (g.repair && 'approval' in g.repair && g.purpose !== 'APPROVE') throw new Error(`policy ${p.name}: gate ${g.id} approval repair on non-APPROVE gate`);
    if (g.resolver === 'NONE' && g.repair) throw new Error(`policy ${p.name}: NONE gate ${g.id} has a repair`);
    const deps = new Set<string>(['FIELDS', ...(g.dependsOn ?? []), ...(g.reads ?? []).map(availId)]);
    add(g, [...deps]);
  }
  // APPROVE depends on every other non-APPROVE gate (implicit, 06 §3).
  for (const g of approve) all.get(g.id)!.deps = [...all.keys()].filter((id) => id !== g.id).concat(CORE);
  // dangling references + cycle check over the expanded graph (core gates are roots).
  for (const g of all.values()) for (const d of g.deps) if (!all.has(d) && !CORE.includes(d)) throw new Error(`policy ${p.name}: ${g.id} depends on unknown ${d}`);
  topoOrder(all);
  return all;
}

function topoOrder(all: Map<string, { deps: string[] }>): string[] {
  const order: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, path: string[]) => {
    if (CORE.includes(id)) return;
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1) throw new Error(`policy cycle: ${[...path, id].join(' -> ')}`);
    state.set(id, 1);
    for (const d of all.get(id)!.deps) visit(d, [...path, id]);
    state.set(id, 2);
    order.push(id);
  };
  for (const id of all.keys()) visit(id, []);
  return order;
}

function admit(p: Policy, a: Action, candidates: Observation[], now: number, mode: Mode) {
  const rejected: Rejection[] = [];
  const bySource = new Map<string, Observation>();
  const specs = new Map(p.evidence.map((e) => [e.kind, e]));
  for (const o of candidates) {
    const id = observationId(o);
    const reject = (reason: string) => rejected.push({ observationId: id, kind: o.kind, sourceId: o.sourceId, reason });
    const spec = specs.get(o.kind);
    if (!spec) { reject('UNKNOWN_KIND'); continue; }
    if (o.sourceClass === 'HYPOTHETICAL' && mode === 'LIVE') { reject('HYPOTHETICAL_IN_LIVE'); continue; }
    const required = spec.sources[o.sourceId];
    if (!required || (o.sourceClass !== required && o.sourceClass !== 'HYPOTHETICAL')) { reject('SOURCE_NOT_ACCEPTED'); continue; }
    if (digest(o.subject) !== digest(spec.subject(a))) { reject('SUBJECT_MISMATCH'); continue; }
    if (o.observedAt > now + SKEW_MS) { reject('FUTURE_DATED'); continue; }
    if (spec.freshness.type === 'MAX_AGE' && now - o.observedAt >= spec.freshness.ms) { reject('EXPIRED'); continue; }
    const key = `${o.kind}\u0000${o.sourceId}`;
    const prev = bySource.get(key);
    if (prev && (prev.sourceRevision > o.sourceRevision || (prev.sourceRevision === o.sourceRevision && prev.observedAt >= o.observedAt))) {
      reject('SUPERSEDED'); continue;
    }
    if (prev) rejected.push({ observationId: observationId(prev), kind: prev.kind, sourceId: prev.sourceId, reason: 'SUPERSEDED' });
    bySource.set(key, o);
  }
  const admitted: Record<string, Observation[]> = {};
  for (const e of p.evidence) {
    admitted[e.kind] = Object.keys(e.sources).map((s) => bySource.get(`${e.kind}\u0000${s}`)).filter((o): o is Observation => !!o);
  }
  return { admitted, rejected };
}

/** evaluateCore (06 §3): never produces previews. */
export function evaluateCore(policy: Policy, snap: Snapshot, meta: Meta, mode: Mode = 'LIVE'): Decision {
  const a = snap.action;
  const now = snap.now;
  const results = new Map<string, GateResult>();
  const base = {
    fingerprint: fingerprint(a), policyName: policy.name, policyHash: meta.policyHash, evaluatorVersion: meta.evaluatorVersion, mode,
  };

  // Step 0: unsupported action type terminates before any adapter call.
  if (a.actionType !== policy.actionType) {
    const g: GateResult = { gateId: 'CONTRACT', status: 'FAIL', resolver: 'NONE', dependsOn: [], reasonCode: 'UNSUPPORTED_ACTION', observed: a.actionType };
    return finish([g], { ...base, rejected: [], admittedIds: [], snapshotRoot: digest([]), preconditions: {}, risk: null, timerUpdates: {} }, snap, policy);
  }
  results.set('CONTRACT', { gateId: 'CONTRACT', status: 'PASS', dependsOn: [] });

  // Step 1: FIELDS.
  const missing = policy.requiredFields.filter((f) => a.params[f] === undefined || a.params[f] === null || a.params[f] === '');
  results.set('FIELDS', missing.length
    ? { gateId: 'FIELDS', status: 'FAIL', resolver: 'REQUESTER', dependsOn: ['CONTRACT'], reasonCode: 'MISSING_FIELDS', required: missing }
    : { gateId: 'FIELDS', status: 'PASS', dependsOn: ['CONTRACT'] });

  const graph = expandPolicy(policy);
  const { admitted, rejected } = missing.length ? { admitted: {} as Record<string, Observation[]>, rejected: [] as Rejection[] } : admit(policy, a, snap.candidates, now, mode);

  let riskMemo: Risk | null = null;
  const ctx: Ctx = {
    action: a, params: a.params as Record<string, any>, admitted, snapshot: snap, policy, mode, meta,
    one: (k) => { const o = admitted[k]?.[0]; if (!o) throw new Error(`evaluator bug: read unavailable evidence ${k}`); return o; },
    val: (k) => ctx.one(k).value as Record<string, any>,
    adjudication: (gateId, conflictDigest) => validAdjudications(snap, policy).find((x) => x.gateId === gateId && x.conflictDigest === conflictDigest),
    risk: () => {
      if (riskMemo) return riskMemo;
      const r = policy.risk(ctx);
      const uUnknown = r.U === 'UNKNOWN';
      const U = uUnknown ? 3 : (r.U as number);
      riskMemo = { I: r.I, B: r.B, U, uUnknown, tier: tierOf(r.I, r.B, U) };
      return riskMemo;
    },
  };

  const satisfied = (id: string) => { const s = results.get(id)?.status; return s === 'PASS' || s === 'NOT_APPLICABLE'; };
  const evalGate = (id: string, def: GateDef & { deps: string[] }) => {
    const unmet = def.deps.filter((d) => !satisfied(d));
    if (unmet.length) { results.set(id, { gateId: id, status: 'BLOCKED', dependsOn: def.deps, blockedBy: unmet }); return; }
    let r: GateResultCore;
    if (id.startsWith('AVAIL(')) {
      const kind = id.slice(6, -1);
      r = admitted[kind]?.length ? { status: 'PASS' } : { status: 'FAIL', reasonCode: 'EVIDENCE_UNAVAILABLE', required: kind };
    } else r = def.eval(ctx);
    results.set(id, {
      gateId: id, status: r.status, dependsOn: def.deps, reasonCode: r.reasonCode, observed: r.observed, required: r.required,
      ...(r.status === 'FAIL' ? { resolver: r.resolver ?? def.resolver, purpose: def.purpose, role: def.role } : {}),
    });
  };

  // VERSIONS (core, 06 §2): every evaluation, every tier. Depends on current-state availability.
  const order = topoOrder(graph);
  const stateKinds = policy.currentState.map((s) => s.kind);
  const evalVersions = () => {
    const deps = ['FIELDS', ...stateKinds.map(availId)];
    const unmet = deps.filter((d) => !satisfied(d));
    if (unmet.length) { results.set('VERSIONS', { gateId: 'VERSIONS', status: 'BLOCKED', dependsOn: deps, blockedBy: unmet }); return; }
    const mismatches = policy.currentState.flatMap((s) => s.compare(a, ctx.val(s.kind)));
    results.set('VERSIONS', mismatches.length
      ? { gateId: 'VERSIONS', status: 'FAIL', resolver: 'NONE', dependsOn: deps, reasonCode: 'STALE_PROPOSAL', observed: mismatches }
      : { gateId: 'VERSIONS', status: 'PASS', dependsOn: deps });
  };
  for (const id of order) if (id.startsWith('AVAIL(')) evalGate(id, graph.get(id)!);
  evalVersions();
  for (const id of order) if (!id.startsWith('AVAIL(')) evalGate(id, graph.get(id)!);

  // Step 7: timers for unresolved EXTERNAL gates (06 §7.2).
  const timerUpdates: Record<string, Timer> = {};
  for (const r of results.values()) {
    if (r.status !== 'FAIL' || r.resolver !== 'EXTERNAL') continue;
    const def = graph.get(r.gateId);
    const t = def?.timeout;
    if (!t) continue;
    const prev = snap.timers[r.gateId];
    const firstBlockedAt = prev?.firstBlockedAt ?? now;
    let deadlineAt: number;
    if (prev?.extended) deadlineAt = prev.deadlineAt;
    else if (t.type === 'KR') deadlineAt = t.releaseAt(ctx) + KR_GRACE_MS;
    else deadlineAt = firstBlockedAt + t.ms;
    const timer = { firstBlockedAt, deadlineAt, extended: prev?.extended ?? false };
    if (!prev || prev.deadlineAt !== deadlineAt) timerUpdates[r.gateId] = timer;
    r.deadlineAt = deadlineAt;
    const cancel = validAdjudications(snap, policy).find((x) => x.gateId === r.gateId && x.decision === 'CANCEL');
    if (cancel) Object.assign(r, { resolver: 'NONE', purpose: undefined, role: undefined, reasonCode: 'CANCELLED_BY_OPERATOR' });
    else if (now >= deadlineAt) Object.assign(r, { resolver: 'AUTHORITY', purpose: 'TIMEOUT', role: 'operator', reasonCode: `TIMEOUT:${r.reasonCode ?? ''}` });
  }

  const admittedAll = Object.values(admitted).flat();
  const { snapshotRoot, preconditions } = binding(policy, admitted, snap);
  const risk = results.get('FIELDS')?.status === 'PASS' ? ctx.risk() : null;
  return finish([...results.values()], {
    ...base, rejected,
    admittedIds: admittedAll.map(observationId).sort(),
    snapshotRoot, preconditions, risk, timerUpdates,
  }, snap, policy);
}

function finish(gates: GateResult[], rest: Omit<Decision, 'outcome' | 'gates' | 'obligations' | 'later' | 'display'>, snap: Snapshot, policy: Policy): Decision {
  const fails = gates.filter((g) => g.status === 'FAIL');
  const blocked = gates.filter((g) => g.status === 'BLOCKED');
  // Totality (06 §3): if anything is unsatisfied, some gate FAILs.
  if (blocked.length && !fails.length) throw new Error('evaluator invariant violated: BLOCKED without FAIL');
  const has = (r: Resolver) => fails.some((g) => g.resolver === r);
  const outcome: Outcome = has('NONE') ? 'REFUSE' : has('AUTHORITY') ? 'ESCALATE' : has('REQUESTER') ? 'ASK' : has('EXTERNAL') ? 'DEFER' : 'EXECUTE';

  const required = policy.evidence.length;
  const available = gates.filter((g) => g.gateId.startsWith('AVAIL(') && g.status === 'PASS').length;
  const admittedSet = new Set(rest.admittedIds);
  const adm = snap.candidates.filter((o) => admittedSet.has(observationId(o)));
  const support: Display['evidenceSupport'] =
    !gates.some((g) => g.gateId.startsWith('AVAIL(')) ? 'NOT_EVALUATED'
      : fails.some((g) => g.gateId.endsWith('-BAD')) ? 'ADVERSE'
        : fails.some((g) => g.purpose === 'ADJUDICATE' && g.gateId.includes('CONFLICT')) ? 'CONTESTED'
          : available < required ? 'INCOMPLETE' : 'COMPLETE';
  const r = rest.risk;
  const display: Display = {
    agentConfidence: { value: snap.agentConfidence ?? null, label: 'Agent-reported, untrusted, not used by any gate' },
    evidenceCoverage: { available, required },
    provenance: {
      adapter: adm.filter((o) => o.sourceClass === 'ADAPTER').length,
      reviewer: adm.filter((o) => o.sourceClass === 'REVIEWER').length,
      requester: adm.filter((o) => o.sourceClass === 'REQUESTER').length,
      rejected: rest.rejected.length,
    },
    evidenceSupport: support,
    riskScore: r ? { ordinal: TIERS.indexOf(r.tier) + 1, of: 4, tier: r.tier, components: `I${r.I}·B${r.B}·U${r.uUnknown ? '3(unknown)' : r.U}` } : null,
  };
  return { ...rest, outcome, gates, obligations: fails, later: blocked, display };
}

/** Strict-snapshot approval validity (06 §8). Used by APPROVE gates; the store checks the same at execution. */
export function approvalValid(c: Ctx, ap: Approval, required: { fingerprint: string; policyHash: string; evaluatorVersion: string; snapshotRoot: string; preconditions: Record<string, string>; role: string }): string | null {
  const s = c.snapshot;
  if (ap.status !== 'ACTIVE') return `status ${ap.status}`;
  if (ap.hypothetical && c.mode === 'LIVE') return 'hypothetical approval in LIVE mode';
  if (ap.revision !== c.action.revision) return 'revision changed';
  if (ap.fingerprint !== required.fingerprint) return 'fingerprint changed';
  if (ap.policyHash !== required.policyHash) return 'policy changed';
  if (ap.evaluatorVersion !== required.evaluatorVersion) return 'evaluator changed';
  if (ap.snapshotRoot !== required.snapshotRoot) return 'evidence snapshot changed';
  if (digest(ap.preconditions) !== digest(required.preconditions)) return 'precondition changed';
  const now = c.risk();
  if (digest(ap.reviewedRisk) !== digest(now)) return 'risk changed';
  if (ap.requiredRole !== required.role) return 'required role changed';
  if (!(s.roles[ap.approverId] ?? []).includes(required.role)) return 'approver no longer holds role';
  if (ap.approverId === c.action.initiatingPrincipal) return 'approver is the requester';
  if (s.now >= ap.expiresAt) return 'expired';
  return null;
}

/** The single APPROVE gate shape shared by every domain. */
export function approveGate(id: string): GateDef {
  return {
    id, resolver: 'AUTHORITY', purpose: 'APPROVE', repair: { approval: true },
    eval: (c) => {
      const role = c.policy.requiredRole(c.risk().tier);
      if (!role) return { status: 'NOT_APPLICABLE', reasonCode: `tier ${c.risk().tier} needs no approval` };
      const rejected = c.snapshot.approvals.find((x) => x.revision === c.action.revision && x.status === 'REJECTED');
      if (rejected) return { status: 'FAIL', resolver: 'NONE', reasonCode: 'APPROVAL_REJECTED', observed: rejected.approverId };
      const { snapshotRoot, preconditions } = snapshotBinding(c);
      const req = { fingerprint: fingerprint(c.action), ...c.meta, snapshotRoot, preconditions, role };
      const reasons = c.snapshot.approvals.map((ap) => approvalValid(c, ap, req));
      const ok = c.snapshot.approvals.find((_, i) => reasons[i] === null);
      if (ok) return { status: 'PASS', observed: { approvalId: ok.approvalId } };
      return { status: 'FAIL', reasonCode: 'APPROVAL_REQUIRED', required: role, observed: { invalid: c.snapshot.approvals.map((ap, i) => ({ approvalId: ap.approvalId, reason: reasons[i] })).filter((x) => x.reason) } };
    },
  };
}

/** 06 §8: expiresAt = min(issuedAt + 10 min, earliest SNAPSHOT observation expiry). */
export function approvalExpiry(policy: Policy, snap: Snapshot, d: Decision): number {
  const ids = new Set(d.admittedIds);
  let exp = snap.now + 10 * MIN;
  for (const o of snap.candidates) {
    const spec = policy.evidence.find((e) => e.kind === o.kind);
    if (spec?.binding === 'SNAPSHOT' && spec.freshness.type === 'MAX_AGE' && ids.has(observationId(o))) exp = Math.min(exp, o.observedAt + spec.freshness.ms);
  }
  return exp;
}

export const snapshotBinding = (c: Ctx) => binding(c.policy, c.admitted, c.snapshot);

/** Strict-snapshot binding (06 §6, §8): SNAPSHOT observations + applicable adjudication records, and exact PRECONDITION values. */
function binding(policy: Policy, admitted: Record<string, Observation[]>, snap: Snapshot) {
  const kinds = new Set(policy.evidence.filter((e) => e.binding === 'SNAPSHOT').map((e) => e.kind));
  const obs = Object.values(admitted).flat().filter((o) => kinds.has(o.kind)).map(observationId);
  const adj = validAdjudications(snap, policy).map((x) => `adj:${digest(x)}`);
  const preconditions: Record<string, string> = {};
  for (const e of policy.evidence) if (e.binding === 'PRECONDITION' && admitted[e.kind]?.length) preconditions[e.kind] = digest(admitted[e.kind][0].value);
  return { snapshotRoot: digest([...obs, ...adj].sort()), preconditions };
}

/** Adjudications for the current revision whose role is the role the gate requires and whose actor currently holds it. */
export function validAdjudications(snap: Snapshot, policy: Policy): Adjudication[] {
  const roleFor = (gateId: string) => (gateId.startsWith('AVAIL(') || policy.gates.find((g) => g.id === gateId)?.timeout ? 'operator' : policy.gates.find((g) => g.id === gateId)?.role);
  return snap.adjudications.filter((x) => x.revision === snap.action.revision && x.role === roleFor(x.gateId) && (snap.roles[x.actor] ?? []).includes(x.role) && x.actor !== snap.action.initiatingPrincipal);
}

/** explainRepairs (06 §3): on demand, bounded (≤ #FAIL + 1 core calls), never recursive, never persisted. */
export function explainRepairs(policy: Policy, snap: Snapshot, meta: Meta, core: Decision) {
  const graph = expandPolicy(policy);
  const repairs: { gateId: string; patch: (s: Snapshot) => Snapshot; label: string }[] = [];
  for (const f of core.obligations) {
    if (f.gateId.startsWith('AVAIL(')) {
      const spec = policy.evidence.find((e) => `AVAIL(${e.kind})` === f.gateId)!;
      if (!spec.hypothetical) continue;
      const v = spec.hypothetical(snap.action);
      repairs.push({ gateId: f.gateId, label: `if ${spec.kind} were available and acceptable`, patch: (s) => ({ ...s, candidates: [...s.candidates, hypo(spec, s, v)] }) });
      continue;
    }
    const def = graph.get(f.gateId);
    const rep = def?.repair;
    if (!rep || f.resolver === 'NONE') continue;
    if ('approval' in rep) {
      repairs.push({ gateId: f.gateId, label: `if ${f.required} approved this exact snapshot`, patch: (s) => ({ ...s, roles: { ...s.roles, __hypothetical__: [String(f.required)] }, approvals: [...s.approvals, hypoApproval(policy, s, meta, core)] }) });
    } else {
      const spec = policy.evidence.find((e) => e.kind === rep.kind)!;
      repairs.push({ gateId: f.gateId, label: `if ${rep.kind} became acceptable`, patch: (s) => ({ ...s, candidates: [...s.candidates, hypo(spec, s, rep.value)] }) });
    }
  }
  const run = (patches: typeof repairs) => {
    const s = patches.reduce((acc, r) => r.patch(acc), snap);
    const d = evaluateCore(policy, s, meta, 'PREVIEW');
    return { outcome: d.outcome, remaining: d.obligations.map((g) => g.gateId) };
  };
  const single = repairs.map((r) => ({ gateId: r.gateId, label: r.label, ...run([r]) }));
  const combined = repairs.length >= 2 ? { gateIds: repairs.map((r) => r.gateId), ...run(repairs) } : null;
  return { single, combined, preview: true as const };
}

function hypo(spec: EvidenceKind, s: Snapshot, value: Record<string, unknown>): Observation {
  return { kind: spec.kind, sourceId: Object.keys(spec.sources)[0], sourceClass: 'HYPOTHETICAL', sourceRevision: Number.MAX_SAFE_INTEGER, subject: spec.subject(s.action), value, observedAt: s.now };
}

function hypoApproval(policy: Policy, s: Snapshot, meta: Meta, d: Decision): Approval {
  const role = d.risk ? policy.requiredRole(d.risk.tier) ?? '' : '';
  return {
    approvalId: 'hypothetical', revision: s.action.revision, fingerprint: d.fingerprint, ...meta, snapshotRoot: d.snapshotRoot,
    preconditions: d.preconditions, reviewedRisk: d.risk!, requiredRole: role, approverId: '__hypothetical__',
    issuedAt: s.now, expiresAt: s.now + 1, status: 'ACTIVE', hypothetical: true,
  };
}
