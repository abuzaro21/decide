// Durable decision store and the ONE execution path (06 §2, §8, §10; 05 §7).
import { randomUUID } from 'node:crypto';
import { canonicalize, digest, sha256 } from './canonical.ts';
import { audit, auditLog, tx, verifyChain, type Db } from './db.ts';
import { evaluateCore, explainRepairs, fingerprint, type Action, type Approval, type Adjudication, type Decision, type Snapshot, type Timer } from './engine.ts';
import { collect, EVALUATOR_VERSION, type Scope } from './world.ts';
import { DOMAINS } from './domains.ts';

export class HttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) { super(String(body.error ?? status)); this.status = status; this.body = body; }
}

export interface Proposer { kind: 'LIVE_LLM' | 'RECORDED_LLM' | 'MANUAL'; model?: string; recordedAt?: string; recordingId?: string; agentConfidence?: number; rationale?: string; prompt?: string }

export type FaultPoint = 'after-mutation' | 'after-audit' | 'before-commit' | 'during-commit' | 'after-commit';
export interface Faults { at: FaultPoint; mode: 'throw' | 'exit' }

const domainOf = (actionType: string) => {
  const d = DOMAINS[actionType];
  if (!d) throw new HttpError(400, { error: 'unsupported actionType', actionType });
  return d;
};
const meta = (actionType: string) => ({ policyHash: domainOf(actionType).policyHash, evaluatorVersion: EVALUATOR_VERSION });

type PropRow = { proposal_id: string; revision: number; status: string; action_json: string; fingerprint: string; proposer_json: string; created_at: number };

export function ensureSession(db: Db, s: Scope, now: number, roles: Record<string, string[]>) {
  tx(db, () => {
    const exists = db.prepare('SELECT 1 FROM sessions WHERE session_id=? AND run_id=?').get(s.sessionId, s.runId);
    if (exists) return;
    db.prepare('INSERT INTO sessions(session_id, run_id, created_at) VALUES (?,?,?)').run(s.sessionId, s.runId, now);
    for (const [principal, rs] of Object.entries(roles)) for (const r of rs) db.prepare('INSERT INTO roles VALUES (?,?,?,?)').run(s.sessionId, s.runId, principal, r);
    audit(db, s.sessionId, s.runId, now, { type: 'SESSION_STARTED', actor: 'system', payload: { roles } });
  });
}

export function loadProposal(db: Db, s: Scope, proposalId: string, revision?: number): PropRow {
  const row = (revision === undefined
    ? db.prepare('SELECT * FROM proposals WHERE session_id=? AND run_id=? AND proposal_id=? ORDER BY revision DESC LIMIT 1').get(s.sessionId, s.runId, proposalId)
    : db.prepare('SELECT * FROM proposals WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=?').get(s.sessionId, s.runId, proposalId, revision)) as PropRow | undefined;
  if (!row) throw new HttpError(404, { error: 'proposal not found in this session' });
  return row;
}

/** Create a proposal (revision 1) or a new revision that supersedes the previous unexecuted one — atomically (06 §2). */
export function propose(db: Db, s: Scope, input: { proposalId?: string; actionType: string; params: Record<string, unknown>; initiatingPrincipal: string; proposer: Proposer }, now: number) {
  const dom = domainOf(input.actionType);
  return tx(db, () => {
    const proposalId = input.proposalId ?? `prop-${randomUUID().slice(0, 8)}`;
    const prev = input.proposalId ? (db.prepare('SELECT * FROM proposals WHERE session_id=? AND run_id=? AND proposal_id=? ORDER BY revision DESC LIMIT 1').get(s.sessionId, s.runId, proposalId) as PropRow | undefined) : undefined;
    if (input.proposalId && !prev) throw new HttpError(404, { error: 'proposal not found in this session' });
    if (prev && prev.status === 'CLOSED_EXECUTED') throw new HttpError(409, { error: 'proposal already executed; create a new proposal' });
    const bound = dom.bind(db, s, input.params as Record<string, any>);
    if (!bound) throw new HttpError(409, { error: 'target state unavailable; cannot bind expected target versions' });
    const action: Action = {
      schemaVersion: 1, sessionId: s.sessionId, runId: s.runId, initiatingPrincipal: input.initiatingPrincipal,
      proposalId, revision: (prev?.revision ?? 0) + 1, actionType: input.actionType, params: input.params, ...bound,
    };
    const fp = fingerprint(action);
    if (prev && prev.status === 'OPEN') {
      db.prepare("UPDATE proposals SET status='SUPERSEDED' WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=?").run(s.sessionId, s.runId, proposalId, prev.revision);
      const inv = db.prepare("UPDATE approvals SET status='INVALIDATED' WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=? AND status='ACTIVE'").run(s.sessionId, s.runId, proposalId, prev.revision);
      audit(db, s.sessionId, s.runId, now, { type: 'REVISION_SUPERSEDED', proposalId, revision: prev.revision, actor: input.initiatingPrincipal, payload: { by: action.revision, approvalsInvalidated: Number(inv.changes) } });
    }
    db.prepare('INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?,?)').run(s.sessionId, s.runId, proposalId, action.revision, 'OPEN', canonicalize(action), fp, canonicalize(input.proposer), now);
    audit(db, s.sessionId, s.runId, now, { type: 'PROPOSED', proposalId, revision: action.revision, actor: input.initiatingPrincipal, payload: { action, fingerprint: fp, proposer: input.proposer } });
    return { proposalId, revision: action.revision, fingerprint: fp };
  });
}

/** Assemble the evaluator input from durable state. Pure reads. */
export function buildSnapshot(db: Db, s: Scope, row: PropRow, now: number): Snapshot {
  const action = JSON.parse(row.action_json) as Action;
  const key = [s.sessionId, s.runId, row.proposal_id, row.revision] as const;
  const approvals = (db.prepare('SELECT approval_json, status FROM approvals WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=? ORDER BY approval_id').all(...key) as { approval_json: string; status: Approval['status'] }[])
    .map((r) => ({ ...JSON.parse(r.approval_json), status: r.status }) as Approval);
  const adjudications = (db.prepare('SELECT adjudication_json FROM adjudications WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=? ORDER BY adjudication_id').all(...key) as { adjudication_json: string }[])
    .map((r) => JSON.parse(r.adjudication_json) as Adjudication);
  const timers: Record<string, Timer> = {};
  for (const t of db.prepare('SELECT gate_id, first_blocked_at, deadline_at, extended FROM gate_timers WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=?').all(...key) as { gate_id: string; first_blocked_at: number; deadline_at: number; extended: number }[])
    timers[t.gate_id] = { firstBlockedAt: t.first_blocked_at, deadlineAt: t.deadline_at, extended: !!t.extended };
  const roles: Record<string, string[]> = {};
  for (const r of db.prepare('SELECT principal, role FROM roles WHERE session_id=? AND run_id=?').all(s.sessionId, s.runId) as { principal: string; role: string }[])
    (roles[r.principal] ??= []).push(r.role);
  const proposer = JSON.parse(row.proposer_json) as Proposer;
  return { action, candidates: collect(db, s), approvals, adjudications, timers, roles, now, agentConfidence: proposer.agentConfidence };
}

/** Persist a decision, its timers and lifecycle transition, plus an audit event when the decision changed. Inside a transaction. */
export function record(db: Db, s: Scope, row: PropRow, snap: Snapshot, d: Decision, now: number, context: 'view' | 'execute') {
  const key = [s.sessionId, s.runId, row.proposal_id, row.revision] as const;
  const last = db.prepare('SELECT decision_id, decision_json FROM decisions WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=? ORDER BY at DESC, rowid DESC LIMIT 1').get(...key) as { decision_id: string; decision_json: string } | undefined;
  // Timers: upsert started/changed, clear those whose gate is no longer an unresolved EXTERNAL failure.
  for (const [gateId, t] of Object.entries(d.timerUpdates))
    db.prepare('INSERT INTO gate_timers VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET deadline_at=excluded.deadline_at').run(...key, gateId, t.firstBlockedAt, t.deadlineAt, t.extended ? 1 : 0);
  const open = new Set(d.obligations.filter((g) => g.deadlineAt !== undefined).map((g) => g.gateId));
  for (const gateId of Object.keys(snap.timers)) if (!open.has(gateId))
    db.prepare('DELETE FROM gate_timers WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=? AND gate_id=?').run(...key, gateId);

  // A new decision record whenever outcome, any gate, the evidence admitted/rejected, or the bound snapshot changes.
  const significant = (x: Decision) => digest({ o: x.outcome, g: x.gates.map((g) => [g.gateId, g.status, g.resolver ?? null, g.purpose ?? null, g.reasonCode ?? null]), a: x.admittedIds, r: x.rejected.map((r) => [r.observationId, r.reason]), root: x.snapshotRoot, pre: x.preconditions });
  const changed = !last || significant(JSON.parse(last.decision_json)) !== significant(d) || context === 'execute';
  let decisionId = last?.decision_id ?? '';
  if (changed) {
    decisionId = `dec-${randomUUID()}`;
    const snapJson = canonicalize(snap);
    const decJson = canonicalize(d);
    db.prepare('INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(decisionId, s.sessionId, s.runId, row.proposal_id, row.revision, d.outcome, context, snapJson, decJson, d.policyHash, d.evaluatorVersion, now);
    audit(db, s.sessionId, s.runId, now, {
      type: 'EVALUATED', proposalId: row.proposal_id, revision: row.revision, decisionId, actor: 'engine',
      payload: { context, outcome: d.outcome, obligations: d.obligations.map((g) => ({ gateId: g.gateId, resolver: g.resolver, purpose: g.purpose, role: g.role, reasonCode: g.reasonCode })), fingerprint: d.fingerprint, snapshotRoot: d.snapshotRoot, policyHash: d.policyHash, evaluatorVersion: d.evaluatorVersion, risk: d.risk, snapshotDigest: sha256(snapJson), decisionDigest: sha256(decJson) },
    });
  }
  // Approvals the engine just found invalid are marked so, with the reason, in this same transaction (audited).
  const appr = d.gates.find((g) => g.status === 'FAIL' && g.purpose === 'APPROVE');
  for (const x of ((appr?.observed as any)?.invalid ?? []) as { approvalId: string; reason: string }[]) {
    const r = db.prepare("UPDATE approvals SET status='INVALIDATED' WHERE approval_id=? AND session_id=? AND run_id=? AND status='ACTIVE'").run(x.approvalId, s.sessionId, s.runId);
    if (Number(r.changes) === 1) audit(db, s.sessionId, s.runId, now, { type: 'APPROVAL_INVALIDATED', proposalId: row.proposal_id, revision: row.revision, actor: 'engine', payload: x });
  }
  if (d.outcome === 'REFUSE') {
    db.prepare("UPDATE proposals SET status='CLOSED_REFUSED' WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=? AND status='OPEN'").run(...key);
    db.prepare("UPDATE approvals SET status='INVALIDATED' WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=? AND status='ACTIVE'").run(...key);
    audit(db, s.sessionId, s.runId, now, { type: 'REVISION_CLOSED', proposalId: row.proposal_id, revision: row.revision, decisionId, actor: 'engine', payload: { status: 'CLOSED_REFUSED', reasons: d.obligations.filter((g) => g.resolver === 'NONE').map((g) => g.reasonCode) } });
  }
  return decisionId;
}

export interface View {
  proposalId: string; revision: number; status: string; action: Action; proposer: Proposer;
  decisionId: string | null; decision: Decision | null; receipt: Record<string, unknown> | null; operationId: string;
}

export const operationIdOf = (s: Scope, proposalId: string, revision: number) => `op-${sha256(canonicalize([s.sessionId, s.runId, proposalId, revision])).slice(0, 32)}`;

/** Passive re-evaluation on view (06 §7.2). Closed/superseded revisions return their terminal record, never a fresh decision (06 §2). */
export function view(db: Db, s: Scope, proposalId: string, now: number, revision?: number): View {
  return tx(db, () => {
    const row = loadProposal(db, s, proposalId, revision);
    const base = { proposalId, revision: row.revision, action: JSON.parse(row.action_json) as Action, proposer: JSON.parse(row.proposer_json) as Proposer, operationId: operationIdOf(s, proposalId, row.revision) };
    const ownedReceipt = ownReceipt(db, s, base.operationId, proposalId, row.revision);
    if (row.status !== 'OPEN') {
      const last = db.prepare('SELECT decision_id, decision_json FROM decisions WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=? ORDER BY at DESC, rowid DESC LIMIT 1').get(s.sessionId, s.runId, proposalId, row.revision) as { decision_id: string; decision_json: string } | undefined;
      return { ...base, status: row.status, decisionId: last?.decision_id ?? null, decision: last ? JSON.parse(last.decision_json) : null, receipt: ownedReceipt };
    }
    const snap = buildSnapshot(db, s, row, now);
    const d = evaluateCore(domainOf(base.action.actionType).policy, snap, meta(base.action.actionType));
    const decisionId = record(db, s, row, snap, d, now, 'view');
    const status = (db.prepare('SELECT status FROM proposals WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=?').get(s.sessionId, s.runId, proposalId, row.revision) as { status: string }).status;
    return { ...base, status, decisionId, decision: d, receipt: null };
  });
}

export function whatWouldChange(db: Db, s: Scope, proposalId: string, now: number) {
  const row = loadProposal(db, s, proposalId);
  if (row.status !== 'OPEN') return { preview: true, single: [], combined: null, note: `revision is ${row.status}` };
  const snap = buildSnapshot(db, s, row, now); // read-only: nothing below writes
  const policy = domainOf(snap.action.actionType).policy;
  const m = meta(snap.action.actionType);
  return explainRepairs(policy, snap, m, evaluateCore(policy, snap, m));
}

export type ExecResult =
  | { status: 'SUCCEEDED'; operationId: string; receipt: Record<string, unknown>; replayed: boolean }
  | { status: 'NOT_EXECUTED'; operationId: string; decisionId: string; decision: Decision };

/** A clock is read only once the transaction lock is held (G2-01): never trust a timestamp taken before waiting. */
export type Clock = number | (() => number);
export const readClock = (c: Clock) => (typeof c === 'function' ? c() : c);

/** Receipt for exactly this (session, run, proposal, revision). A row with the same id but other ownership is an integrity fault, never a success (G2-07). */
function ownReceipt(db: Db, s: Scope, operationId: string, proposalId: string, revision: number) {
  const r = db.prepare('SELECT receipt_json, session_id, run_id, proposal_id, revision FROM receipts WHERE operation_id=?').get(operationId) as
    { receipt_json: string; session_id: string; run_id: string; proposal_id: string; revision: number } | undefined;
  if (!r) return null;
  if (r.session_id !== s.sessionId || r.run_id !== s.runId || r.proposal_id !== proposalId || r.revision !== revision)
    throw new Error('integrity fault: operation id collides with a receipt owned by another proposal');
  return JSON.parse(r.receipt_json) as Record<string, unknown>;
}

/**
 * The single authoritative execution path. One BEGIN IMMEDIATE transaction:
 * receipt lookup → revision OPEN → re-collect → evaluateCore(LIVE) (incl. VERSIONS + approval validity)
 * → simulated effect + approval consumption + receipt + audit → COMMIT. Any failure before COMMIT rolls back.
 */
export function execute(db: Db, s: Scope, proposalId: string, revision: number, actor: string, clock: Clock, faults?: Faults): ExecResult {
  const operationId = operationIdOf(s, proposalId, revision);
  const fault = (at: FaultPoint) => {
    if (faults?.at !== at) return;
    if (faults.mode === 'exit') process.exit(86); // simulated crash: no ROLLBACK, no COMMIT
    throw new Error(`injected fault at ${at}`);
  };
  // none = no COMMIT issued (a rollback proves no effect) · attempted = COMMIT issued, outcome unknown · done = COMMIT returned.
  const st = { commit: 'none' as 'none' | 'attempted' | 'done' };
  const doCommit = () => { st.commit = 'attempted'; db.exec('COMMIT'); fault('during-commit'); st.commit = 'done'; };
  try {
    db.exec('BEGIN IMMEDIATE');
    let result: ExecResult;
    try {
      const now = readClock(clock);
      const existing = ownReceipt(db, s, operationId, proposalId, revision);
      if (existing) { doCommit(); return { status: 'SUCCEEDED', operationId, receipt: existing, replayed: true }; }
      const row = loadProposal(db, s, proposalId, revision);
      if (row.status !== 'OPEN') throw new HttpError(409, { error: `revision is ${row.status}`, status: row.status });
      const snap = buildSnapshot(db, s, row, now);
      const dom = domainOf(snap.action.actionType);
      const d = evaluateCore(dom.policy, snap, meta(snap.action.actionType));
      const decisionId = record(db, s, row, snap, d, now, 'execute');
      if (d.outcome !== 'EXECUTE') { doCommit(); return { status: 'NOT_EXECUTED', operationId, decisionId, decision: d }; }
      const effect = dom.apply(db, s, snap.action, now);
      fault('after-mutation');
      const approvalId = (d.gates.find((g) => (g.observed as any)?.approvalId)?.observed as any)?.approvalId as string | undefined;
      if (approvalId) {
        const used = db.prepare("UPDATE approvals SET status='CONSUMED' WHERE approval_id=? AND session_id=? AND run_id=? AND proposal_id=? AND revision=? AND status='ACTIVE'").run(approvalId, s.sessionId, s.runId, proposalId, revision);
        if (Number(used.changes) !== 1) throw new Error('approval could not be consumed exactly once');
      }
      const receipt = { operationId, proposalId, revision, fingerprint: d.fingerprint, decisionId, approvalId: approvalId ?? null, effect, executedAt: now, actor };
      db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?,?,?)').run(operationId, s.sessionId, s.runId, proposalId, revision, canonicalize(receipt), now);
      db.prepare("UPDATE proposals SET status='CLOSED_EXECUTED' WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=?").run(s.sessionId, s.runId, proposalId, revision);
      audit(db, s.sessionId, s.runId, now, { type: 'EXECUTED', proposalId, revision, decisionId, actor, payload: receipt });
      fault('after-audit');
      fault('before-commit');
      doCommit();
      result = { status: 'SUCCEEDED', operationId, receipt, replayed: false };
    } catch (e) {
      // Still inside the transaction ⇒ nothing was committed: roll back, and the effect provably did not happen.
      if (st.commit !== 'done' && db.isTransaction) { db.exec('ROLLBACK'); st.commit = 'none'; }
      throw e;
    }
    fault('after-commit');
    return result;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const unknown = st.commit !== 'none'; // a COMMIT was issued: this response cannot tell the caller whether the effect happened
    throw new HttpError(unknown ? 500 : 503, unknown
      ? { status: 'UNCONFIRMED', operationId, error: 'result unconfirmed; retry the same operation to retrieve its receipt' }
      : { status: 'UNAVAILABLE_PRE_COMMIT', operationId, error: 'no decision made, nothing executed', cause: String((e as Error).message) });
  }
}

export function getReceipt(db: Db, s: Scope, operationId: string) {
  const r = db.prepare('SELECT receipt_json FROM receipts WHERE operation_id=? AND session_id=? AND run_id=?').get(operationId, s.sessionId, s.runId) as { receipt_json: string } | undefined;
  if (!r) throw new HttpError(404, { error: 'no receipt for this operation in this session' });
  return JSON.parse(r.receipt_json);
}

/** Replay = run the evaluator offline over the stored snapshot (evidence candidates, so admission is re-run) and compare. */
export function replay(db: Db, s: Scope, decisionId: string) {
  const r = db.prepare('SELECT snapshot_json, decision_json, evaluator_version FROM decisions WHERE decision_id=? AND session_id=? AND run_id=?').get(decisionId, s.sessionId, s.runId) as { snapshot_json: string; decision_json: string; evaluator_version: string } | undefined;
  if (!r) throw new HttpError(404, { error: 'decision not found in this session' });
  // The EVALUATED audit event committed to digests of the exact stored snapshot and decision; verify before replaying (G2-05).
  const chain = verifyChain(db, s.sessionId, s.runId);
  if (!chain.ok) return { replayable: false, reason: `AUDIT_CHAIN_INVALID(${(chain as any).reason})` };
  const ev = auditLog(db, s.sessionId, s.runId).map((x) => JSON.parse(x.envelope_json)).find((x) => x.type === 'EVALUATED' && x.decisionId === decisionId);
  if (!ev) return { replayable: false, reason: 'NO_AUDIT_COMMITMENT' };
  if (ev.payload.snapshotDigest !== sha256(r.snapshot_json) || ev.payload.decisionDigest !== sha256(r.decision_json))
    return { replayable: false, reason: 'STORED_DECISION_DOES_NOT_MATCH_AUDIT' };
  if (r.evaluator_version !== EVALUATOR_VERSION) return { replayable: false, reason: `NOT_REPLAYABLE(evaluator ${r.evaluator_version} != ${EVALUATOR_VERSION})` };
  const snap = JSON.parse(r.snapshot_json) as Snapshot;
  const recorded = JSON.parse(r.decision_json) as Decision;
  const current = domainOf(snap.action.actionType).policyHash;
  if (recorded.policyHash !== current) return { replayable: false, reason: `NOT_REPLAYABLE(policy ${recorded.policyHash} != ${current})` };
  const again = evaluateCore(domainOf(snap.action.actionType).policy, snap, { policyHash: recorded.policyHash, evaluatorVersion: recorded.evaluatorVersion });
  const identical = canonicalize(again) === canonicalize(recorded);
  return { replayable: true, identical, outcome: again.outcome, recordedOutcome: recorded.outcome };
}
