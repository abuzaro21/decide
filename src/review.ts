// G3 — human decisions: strict-snapshot approval/rejection (06 §8) and typed adjudication / timeout commands (06 §7).
// Every command re-evaluates inside its transaction and is accepted only when the gate it targets is FAIL right now.
import { randomUUID } from 'node:crypto';
import { canonicalize } from './canonical.ts';
import { audit, tx, type Db } from './db.ts';
import { approvalExpiry, evaluateCore, type Adjudication, type Approval, type Decision, type GateResult } from './engine.ts';
import { buildSnapshot, HttpError, loadProposal, readClock, record, view, type Clock } from './store.ts';
import { EVALUATOR_VERSION, type Scope } from './world.ts';
import { DOMAINS } from './domains.ts';

const TIMEOUT_DECISIONS = ['CANCEL', 'EXTEND_ONCE'];

function current(db: Db, s: Scope, proposalId: string, revision: number, now: number) {
  const row = loadProposal(db, s, proposalId, revision);
  if (row.status !== 'OPEN') throw new HttpError(409, { error: `revision is ${row.status}` });
  const snap = buildSnapshot(db, s, row, now);
  const dom = DOMAINS[snap.action.actionType];
  const d = evaluateCore(dom.policy, snap, { policyHash: dom.policyHash, evaluatorVersion: EVALUATOR_VERSION });
  return { row, snap, dom, d };
}

const holds = (db: Db, s: Scope, principal: string, role: string) =>
  !!db.prepare('SELECT 1 FROM roles WHERE session_id=? AND run_id=? AND principal=? AND role=?').get(s.sessionId, s.runId, principal, role);

/** Approve or reject the exact snapshot the reviewer sees. Allowed only while the APPROVE gate is FAIL (which implies every other gate passes). */
export function review(db: Db, s: Scope, proposalId: string, revision: number, approverId: string, verdict: 'APPROVE' | 'REJECT', reviewToken: string, clock: Clock) {
  let now = 0;
  tx(db, () => {
    now = readClock(clock);
    const { row, snap, dom, d } = current(db, s, proposalId, revision, now);
    // The reviewer consents to what they were shown, not to whatever the state is now (G3-01).
    if (reviewToken !== d.reviewToken) throw new HttpError(409, { error: 'the snapshot changed since it was shown to the reviewer; review the current one', status: 'STALE_REVIEW' });
    const gate = d.obligations.find((g) => g.purpose === 'APPROVE');
    if (!gate || d.obligations.length !== 1) throw new HttpError(409, { error: 'approval is not requestable now', outcome: d.outcome, obligations: d.obligations.map((g) => g.gateId) });
    const role = String(gate.required);
    if (!holds(db, s, approverId, role)) throw new HttpError(403, { error: `approver does not hold required role ${role}` });
    if (approverId === snap.action.initiatingPrincipal) throw new HttpError(403, { error: 'the requester cannot approve its own action' });
    const ap: Approval = {
      approvalId: `apv-${randomUUID().slice(0, 12)}`, revision, fingerprint: d.fingerprint, policyHash: d.policyHash, evaluatorVersion: d.evaluatorVersion,
      snapshotRoot: d.snapshotRoot, preconditions: d.preconditions, reviewedRisk: d.risk!, requiredRole: role, approverId,
      issuedAt: now, expiresAt: approvalExpiry(dom.policy, snap, d), status: verdict === 'APPROVE' ? 'ACTIVE' : 'REJECTED',
    };
    db.prepare('INSERT INTO approvals VALUES (?,?,?,?,?,?,?)').run(ap.approvalId, s.sessionId, s.runId, proposalId, revision, canonicalize(ap), ap.status);
    audit(db, s.sessionId, s.runId, now, { type: verdict === 'APPROVE' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED', proposalId, revision, actor: approverId, payload: ap });
    const again = buildSnapshot(db, s, row, now);
    record(db, s, row, again, evaluateCore(dom.policy, again, { policyHash: dom.policyHash, evaluatorVersion: EVALUATOR_VERSION }), now, 'view');
  });
  return view(db, s, proposalId, now, revision);
}

/** Typed adjudication / timeout command (06 §7.1): only the decisions the open gate allows, only by its role, only against the current conflict set. */
export function adjudicate(db: Db, s: Scope, proposalId: string, revision: number, actor: string, cmd: { gateId: string; decision: string; selection?: string; reviewed: string }, clock: Clock) {
  let now = 0;
  tx(db, () => {
    now = readClock(clock);
    const { row, snap, dom, d } = current(db, s, proposalId, revision, now);
    const gate: GateResult | undefined = d.obligations.find((g) => g.gateId === cmd.gateId);
    if (!gate || (gate.purpose !== 'ADJUDICATE' && gate.purpose !== 'TIMEOUT')) throw new HttpError(409, { error: 'that gate is not awaiting adjudication now', gateId: cmd.gateId });
    const role = String(gate.role);
    if (!holds(db, s, actor, role)) throw new HttpError(403, { error: `actor does not hold required role ${role}` });
    if (actor === snap.action.initiatingPrincipal) throw new HttpError(403, { error: 'the requester cannot adjudicate its own action' });
    let conflictDigest = '';
    // The command must name the exact conflict/flag/timer episode its author reviewed (G3-02).
    const episode = gate.purpose === 'TIMEOUT' ? String(gate.deadlineAt) : String((gate.observed as any)?.conflictDigest ?? '');
    if (cmd.reviewed !== episode) throw new HttpError(409, { error: 'the situation changed since it was shown; review the current one', status: 'STALE_COMMAND' });
    if (gate.purpose === 'TIMEOUT') {
      if (!TIMEOUT_DECISIONS.includes(cmd.decision)) throw new HttpError(400, { error: 'timeout allows only CANCEL or EXTEND_ONCE' });
      const t = snap.timers[cmd.gateId];
      if (cmd.decision === 'EXTEND_ONCE') {
        if (!t || t.extended) throw new HttpError(409, { error: 'extension already used; only CANCEL is allowed now' });
        const duration = t.deadlineAt - t.firstBlockedAt;
        db.prepare('UPDATE gate_timers SET deadline_at=?, extended=1 WHERE session_id=? AND run_id=? AND proposal_id=? AND revision=? AND gate_id=?')
          .run(now + duration, s.sessionId, s.runId, proposalId, revision, cmd.gateId);
      }
    } else {
      const def = dom.policy.gates.find((g) => g.id === cmd.gateId);
      if (!def?.decisions?.includes(cmd.decision)) throw new HttpError(400, { error: 'decision not allowed for this gate', allowed: def?.decisions ?? [] });
      const observed = gate.observed as { conflictDigest?: string; candidates?: { observationId: string }[] } | undefined;
      conflictDigest = observed?.conflictDigest ?? '';
      if (cmd.decision === 'SELECT_OBSERVATION' && !observed?.candidates?.some((c) => c.observationId === cmd.selection))
        throw new HttpError(400, { error: 'selection must be one of the currently conflicting observations' });
    }
    const adj: Adjudication = { revision, gateId: cmd.gateId, conflictDigest, decision: cmd.decision, ...(cmd.selection ? { selection: cmd.selection } : {}), role, actor };
    db.prepare('INSERT INTO adjudications VALUES (?,?,?,?,?,?)').run(`adj-${randomUUID().slice(0, 12)}`, s.sessionId, s.runId, proposalId, revision, canonicalize(adj));
    audit(db, s.sessionId, s.runId, now, { type: 'ADJUDICATED', proposalId, revision, actor, payload: adj });
    const again = buildSnapshot(db, s, row, now);
    const after: Decision = evaluateCore(dom.policy, again, { policyHash: dom.policyHash, evaluatorVersion: EVALUATOR_VERSION });
    record(db, s, row, again, after, now, 'view');
  });
  return view(db, s, proposalId, now, revision);
}
