// SQLite schema, transactions and the hash-linked audit chain (06 §2, 05 §8).
import { DatabaseSync } from 'node:sqlite';
import { canonicalize, sha256 } from './canonical.ts';

export type Db = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS sessions(session_id TEXT NOT NULL, run_id TEXT NOT NULL, created_at INTEGER NOT NULL, clock_offset_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, run_id));
CREATE TABLE IF NOT EXISTS roles(session_id TEXT NOT NULL, run_id TEXT NOT NULL, principal TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(session_id, run_id, principal, role));
-- Simulated external sources. One row per (source, kind, subject); a publish bumps source_revision.
CREATE TABLE IF NOT EXISTS world_obs(
  session_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, subject_key TEXT NOT NULL,
  source_class TEXT NOT NULL CHECK(source_class IN ('ADAPTER','REVIEWER','REQUESTER')),
  subject_json TEXT NOT NULL, value_json TEXT NOT NULL, source_revision INTEGER NOT NULL, observed_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, run_id, kind, source_id, source_class, subject_key));
CREATE TABLE IF NOT EXISTS proposals(
  session_id TEXT NOT NULL, run_id TEXT NOT NULL, proposal_id TEXT NOT NULL, revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','SUPERSEDED','CLOSED_REFUSED','CLOSED_EXECUTED')),
  action_json TEXT NOT NULL, fingerprint TEXT NOT NULL, proposer_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, run_id, proposal_id, revision));
CREATE TABLE IF NOT EXISTS decisions(
  decision_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, proposal_id TEXT NOT NULL, revision INTEGER NOT NULL,
  outcome TEXT NOT NULL, context TEXT NOT NULL, snapshot_json TEXT NOT NULL, decision_json TEXT NOT NULL,
  policy_hash TEXT NOT NULL, evaluator_version TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approvals(
  approval_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, proposal_id TEXT NOT NULL, revision INTEGER NOT NULL,
  approval_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ACTIVE','CONSUMED','INVALIDATED','REJECTED')));
CREATE TABLE IF NOT EXISTS adjudications(
  adjudication_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, proposal_id TEXT NOT NULL, revision INTEGER NOT NULL,
  adjudication_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gate_timers(
  session_id TEXT NOT NULL, run_id TEXT NOT NULL, proposal_id TEXT NOT NULL, revision INTEGER NOT NULL, gate_id TEXT NOT NULL,
  first_blocked_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, extended INTEGER NOT NULL,
  PRIMARY KEY(session_id, run_id, proposal_id, revision, gate_id));
CREATE TABLE IF NOT EXISTS receipts(
  operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, proposal_id TEXT NOT NULL, revision INTEGER NOT NULL,
  receipt_json TEXT NOT NULL, at INTEGER NOT NULL,
  UNIQUE(session_id, run_id, proposal_id, revision));
CREATE TABLE IF NOT EXISTS audit(
  session_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL, envelope_json TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY(session_id, run_id, seq));
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS receipts_no_update BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT, 'receipts are immutable'); END;
`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside BEGIN IMMEDIATE ... COMMIT; any throw rolls back. Not re-entrant by design. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

export const GENESIS = '0'.repeat(64);

export interface AuditEvent {
  type: string;
  proposalId?: string;
  revision?: number;
  decisionId?: string;
  actor: string;
  payload: unknown;
}

/** Append one audit event. Must be called inside the same transaction as the state change it records. */
export function audit(db: Db, sessionId: string, runId: string, now: number, ev: AuditEvent): { seq: number; hash: string } {
  if (!db.isTransaction) throw new Error('audit append outside a transaction');
  const last = db.prepare('SELECT seq, hash FROM audit WHERE session_id=? AND run_id=? ORDER BY seq DESC LIMIT 1').get(sessionId, runId) as { seq: number; hash: string } | undefined;
  const seq = (last?.seq ?? 0) + 1;
  const prev = last?.hash ?? GENESIS;
  const envelope = { runId, sessionId, seq, ts: now, ...ev };
  const json = canonicalize(envelope);
  const hash = sha256(prev + json);
  db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?)').run(sessionId, runId, seq, json, prev, hash);
  return { seq, hash };
}

export function auditLog(db: Db, sessionId: string, runId: string) {
  return (db.prepare('SELECT seq, envelope_json, prev_hash, hash FROM audit WHERE session_id=? AND run_id=? ORDER BY seq').all(sessionId, runId) as
    { seq: number; envelope_json: string; prev_hash: string; hash: string }[]);
}

/** Recompute the chain. If `head` (an earlier exported head) is given, the chain must contain it unchanged. */
export function verifyChain(db: Db, sessionId: string, runId: string, head?: { seq: number; hash: string }) {
  let prev = GENESIS;
  const rows = auditLog(db, sessionId, runId);
  for (const r of rows) {
    const env = JSON.parse(r.envelope_json);
    if (r.prev_hash !== prev) return { ok: false, at: r.seq, reason: 'prev_hash mismatch' };
    if (env.seq !== r.seq || env.sessionId !== sessionId || env.runId !== runId) return { ok: false, at: r.seq, reason: 'envelope identity mismatch' };
    if (canonicalize(env) !== r.envelope_json) return { ok: false, at: r.seq, reason: 'non-canonical envelope' };
    if (sha256(prev + r.envelope_json) !== r.hash) return { ok: false, at: r.seq, reason: 'hash mismatch' };
    prev = r.hash;
  }
  if (head) {
    const at = rows.find((r) => r.seq === head.seq);
    if (!at || at.hash !== head.hash) return { ok: false, at: head.seq, reason: 'exported head not found in chain' };
  }
  const last = rows.at(-1);
  return { ok: true, length: rows.length, head: { runId, seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS } };
}
