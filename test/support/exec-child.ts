// Separate process / worker that opens its OWN SQLite connection and runs the real execute() path.
// argv (process mode): dbPath sessionId runId proposalId revision now faultAt|none faultMode
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../../src/db.ts';
import { execute, HttpError, type Faults } from '../../src/store.ts';

function run(a: { db: string; sessionId: string; runId: string; proposalId: string; revision: number; now: number; fault?: Faults }) {
  const db = openDb(a.db);
  try {
    const r = execute(db, { sessionId: a.sessionId, runId: a.runId }, a.proposalId, a.revision, 'agent:deploy-bot', a.now, a.fault);
    return { ok: true, status: r.status, replayed: r.status === 'SUCCEEDED' ? r.replayed : null };
  } catch (e) {
    return { ok: false, status: e instanceof HttpError ? String(e.body.status ?? e.status) : String(e) };
  } finally { db.close(); }
}

if (!isMainThread) parentPort!.postMessage(run(workerData));
else if (process.argv[2]) {
  const [db, sessionId, runId, proposalId, revision, now, at, mode] = process.argv.slice(2);
  const out = run({ db, sessionId, runId, proposalId, revision: Number(revision), now: Number(now), fault: at === 'none' ? undefined : { at: at as Faults['at'], mode: mode as Faults['mode'] } });
  process.stdout.write(JSON.stringify(out));
}
