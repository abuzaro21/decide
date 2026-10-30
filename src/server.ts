// HTTP API. One process, one SQLite file. Every request is scoped to a server-issued session in the current run.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openDb, tx, audit, auditLog, verifyChain, type Db } from './db.ts';
import { ensureSession, execute, getReceipt, HttpError, propose, replay, view, whatWouldChange, type Proposer } from './store.ts';
import { adjudicate, review } from './review.ts';
import { CONTROLS, DEMO_ROLES, SCENARIOS } from './scenarios.ts';
import { EVALUATOR_VERSION, publish, type Scope } from './world.ts';
import { DOMAINS } from './domains.ts';
import { loadRecordings, proposeLive, PROPOSER_MODEL } from './proposer.ts';

import { PARAMS } from './contracts.ts';
const Str = z.string().min(1).max(200);
const ProposerIn = z.strictObject({
  kind: z.literal('MANUAL').default('MANUAL'),
  agentConfidence: z.number().min(0).max(1).optional(), rationale: z.string().max(4000).optional(), prompt: z.string().max(4000).optional(),
});
const ProposeIn = z.strictObject({ actionType: Str, params: z.record(z.string(), z.unknown()), proposer: ProposerIn.default({ kind: 'MANUAL' }) });
const ReviseIn = z.strictObject({ params: z.record(z.string(), z.unknown()), proposer: ProposerIn.default({ kind: 'MANUAL' }) });
const ControlIn = z.strictObject({ control: Str });
const EvidenceIn = z.strictObject({ kind: Str, sourceId: Str, subject: z.record(z.string(), z.union([z.string(), z.number()])), value: z.record(z.string(), z.unknown()) });
const ClockIn = z.strictObject({ advanceMinutes: z.number().int().min(1).max(24 * 60) });
const ReviewIn = z.strictObject({ approverId: Str, verdict: z.enum(['APPROVE', 'REJECT']), reviewToken: Str });
const AdjudicateIn = z.strictObject({ actor: Str, gateId: Str, decision: Str, selection: Str.optional(), reviewed: Str });

const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, { error: 'invalid request', issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
};

const AGENT = 'agent:deploy-bot';
const COOKIE = 'decide_sid';
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export interface AppOptions { dbPath: string; runId?: string; clock?: () => number }

export function createApp(opts: AppOptions) {
  const db: Db = openDb(opts.dbPath);
  const runId = opts.runId ?? `run-${randomUUID().slice(0, 8)}`;
  const startedAt = (opts.clock ?? Date.now)();
  const clockFor = (s: Scope) => {
    const r = db.prepare('SELECT clock_offset_ms FROM sessions WHERE session_id=? AND run_id=?').get(s.sessionId, s.runId) as { clock_offset_ms: number } | undefined;
    return (opts.clock ?? Date.now)() + (r?.clock_offset_ms ?? 0);
  };

  const sessionOf = (req: IncomingMessage): Scope => {
    const raw = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!raw) throw new HttpError(401, { error: 'no session; POST /api/session first' });
    let decoded: string;
    try { decoded = decodeURIComponent(raw); } catch { throw new HttpError(401, { error: 'malformed session cookie' }); }
    const [sessionId, cookieRun] = decoded.split('.');
    if (cookieRun !== runId) throw new HttpError(410, { error: 'this demo run was restarted; your previous session and its data no longer exist', currentRunId: runId, startedAt });
    const ok = db.prepare('SELECT 1 FROM sessions WHERE session_id=? AND run_id=?').get(sessionId, runId);
    if (!ok) throw new HttpError(401, { error: 'unknown session' });
    return { sessionId, runId };
  };

  async function body(req: IncomingMessage): Promise<unknown> {
    let size = 0; const chunks: Buffer[] = [];
    for await (const c of req) { size += (c as Buffer).length; if (size > 64 * 1024) throw new HttpError(413, { error: 'body too large' }); chunks.push(c as Buffer); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, { error: 'invalid JSON' }); }
  }

  const proposalAction = (s: Scope, pid: string) => view(db, s, pid, clockFor(s)).action;

  type Route = [string, RegExp, (req: IncomingMessage, m: RegExpMatchArray, res: ServerResponse) => Promise<unknown> | unknown];
  const routes: Route[] = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, buildSha: process.env.RENDER_GIT_COMMIT ?? process.env.DEMO_BUILD_SHA ?? 'unknown', runId, startedAt, evaluatorVersion: EVALUATOR_VERSION, liveProposer: !!process.env.ANTHROPIC_API_KEY, policies: Object.fromEntries(Object.entries(DOMAINS).map(([k, d]) => [k, d.policyHash])), persistence: 'SQLite file for the lifetime of this run; a restart starts a new run' })],
    ['POST', /^\/api\/session$/, (_req, _m, res) => {
      const s = { sessionId: `sess-${randomUUID()}`, runId };
      ensureSession(db, s, clockFor(s), DEMO_ROLES);
      res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(`${s.sessionId}.${runId}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
      return { sessionId: s.sessionId, runId, roles: DEMO_ROLES };
    }],
    ['GET', /^\/api\/session$/, (req) => { const s = sessionOf(req); return { ...s, now: clockFor(s), roles: DEMO_ROLES }; }],
    ['GET', /^\/api\/scenarios$/, () => SCENARIOS.map(({ id, title, domain }) => ({ id, title, domain }))],
    ['POST', /^\/api\/scenarios\/([\w-]+)$/, (req, m) => {
      const s = sessionOf(req);
      const sc = SCENARIOS.find((x) => x.id === m[1]);
      if (!sc) throw new HttpError(404, { error: 'unknown scenario' });
      return sc.seed(db, s, clockFor(s));
    }],
    // Genuine recorded proposer outputs (keyless mode). Shown verbatim with their model id and recording time.
    ['GET', /^\/api\/recordings$/, () => loadRecordings().map(({ recordingId, scenarioId, model, recordedAt, via, request, rawOutput, parsed }) => ({ recordingId, scenarioId, model, recordedAt, via, request, rawOutput, parsed }))],
    // Optional live proposer: only when ANTHROPIC_API_KEY is configured on the server. Its output is untrusted input like any other proposal.
    ['POST', /^\/api\/agent$/, async (req) => {
      const s = sessionOf(req);
      const { request } = parse(z.strictObject({ request: z.string().min(1).max(2000) }), await body(req));
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new HttpError(503, { error: 'live proposer not configured on this server; recorded genuine outputs are used instead' });
      const live = await proposeLive(request, key);
      const params = PARAMS[live.parsed.actionType] ? parse(PARAMS[live.parsed.actionType], live.parsed.params) as Record<string, unknown> : live.parsed.params;
      if (!DOMAINS[live.parsed.actionType]) throw new HttpError(422, { error: 'the model proposed an unsupported action type', raw: live.raw });
      return { raw: live.raw, model: live.model, ...propose(db, s, { actionType: live.parsed.actionType, params, initiatingPrincipal: AGENT,
        proposer: { kind: 'LIVE_LLM', model: live.model || PROPOSER_MODEL, agentConfidence: live.parsed.agentConfidence, rationale: live.parsed.rationale, prompt: request } }, clockFor(s)) };
    }],
    ['GET', /^\/api\/controls$/, () => CONTROLS.map(({ id, label, domain }) => ({ id, label, domain }))],
    ['POST', /^\/api\/proposals$/, async (req) => {
      const s = sessionOf(req);
      const b = parse(ProposeIn, await body(req));
      const schema = PARAMS[b.actionType];
      const params = schema ? parse(schema, b.params) as Record<string, unknown> : b.params; // unknown types still reach CONTRACT → REFUSE
      if (!DOMAINS[b.actionType]) throw new HttpError(400, { error: 'unsupported actionType', actionType: b.actionType });
      return propose(db, s, { actionType: b.actionType, params, initiatingPrincipal: AGENT, proposer: b.proposer as Proposer }, clockFor(s));
    }],
    ['POST', /^\/api\/proposals\/([\w-]+)\/revisions$/, async (req, m) => {
      const s = sessionOf(req);
      const b = parse(ReviseIn, await body(req));
      const a = proposalAction(s, m[1]);
      const params = parse(PARAMS[a.actionType], b.params) as Record<string, unknown>;
      return propose(db, s, { proposalId: m[1], actionType: a.actionType, params, initiatingPrincipal: AGENT, proposer: b.proposer as Proposer }, clockFor(s));
    }],
    ['GET', /^\/api\/proposals\/([\w-]+)$/, (req, m) => { const s = sessionOf(req); return view(db, s, m[1], clockFor(s)); }],
    ['GET', /^\/api\/proposals\/([\w-]+)\/what-would-change$/, (req, m) => { const s = sessionOf(req); return whatWouldChange(db, s, m[1], clockFor(s)); }],
    // The clock is read INSIDE the execution transaction, after the write lock is held (G2-01).
    ['POST', /^\/api\/proposals\/([\w-]+)\/revisions\/(\d+)\/execute$/, (req, m) => { const s = sessionOf(req); return execute(db, s, m[1], Number(m[2]), AGENT, () => clockFor(s)); }],
    ['POST', /^\/api\/proposals\/([\w-]+)\/revisions\/(\d+)\/review$/, async (req, m) => {
      const s = sessionOf(req); const b = parse(ReviewIn, await body(req));
      return review(db, s, m[1], Number(m[2]), b.approverId, b.verdict, b.reviewToken, () => clockFor(s));
    }],
    ['POST', /^\/api\/proposals\/([\w-]+)\/revisions\/(\d+)\/adjudicate$/, async (req, m) => {
      const s = sessionOf(req); const b = parse(AdjudicateIn, await body(req));
      return adjudicate(db, s, m[1], Number(m[2]), b.actor, { gateId: b.gateId, decision: b.decision, selection: b.selection, reviewed: b.reviewed }, () => clockFor(s));
    }],
    // Ground truth the engine never sees (K-1 known failure) — shown so the failure is honest, not hidden.
    ['GET', /^\/api\/ground-truth$/, (req) => {
      const s = sessionOf(req);
      return (db.prepare("SELECT subject_json, value_json FROM world_obs WHERE session_id=? AND run_id=? AND kind='ground_truth'").all(s.sessionId, s.runId) as { subject_json: string; value_json: string }[])
        .map((r) => ({ subject: JSON.parse(r.subject_json), ...JSON.parse(r.value_json) }));
    }],
    ['POST', /^\/api\/proposals\/([\w-]+)\/world$/, async (req, m) => {
      const s = sessionOf(req);
      const { control } = parse(ControlIn, await body(req));
      const a = proposalAction(s, m[1]);
      const c = CONTROLS.find((x) => x.id === control && x.domain === a.actionType);
      if (!c) throw new HttpError(404, { error: 'unknown world control for this domain' });
      const now = clockFor(s);
      tx(db, () => { c.apply(db, s, a, now); audit(db, s.sessionId, s.runId, now, { type: 'WORLD_EVENT', proposalId: a.proposalId, actor: 'simulator', payload: { control, simulated: true } }); });
      return view(db, s, m[1], now);
    }],
    // Requester-asserted evidence: stored with REQUESTER provenance whatever sourceId it claims (T-02 / injection demo).
    ['POST', /^\/api\/proposals\/([\w-]+)\/evidence$/, async (req, m) => {
      const s = sessionOf(req);
      const e = parse(EvidenceIn, await body(req));
      const now = clockFor(s);
      const a = proposalAction(s, m[1]);
      tx(db, () => { publish(db, s, { ...e, sourceClass: 'REQUESTER' }, now); audit(db, s.sessionId, s.runId, now, { type: 'REQUESTER_EVIDENCE', proposalId: a.proposalId, actor: AGENT, payload: e }); });
      return view(db, s, m[1], now);
    }],
    ['POST', /^\/api\/clock$/, async (req) => {
      const s = sessionOf(req);
      const { advanceMinutes } = parse(ClockIn, await body(req));
      tx(db, () => {
        db.prepare('UPDATE sessions SET clock_offset_ms = clock_offset_ms + ? WHERE session_id=? AND run_id=?').run(advanceMinutes * 60_000, s.sessionId, s.runId);
        audit(db, s.sessionId, s.runId, clockFor(s), { type: 'CLOCK_ADVANCED', actor: 'simulator', payload: { advanceMinutes, simulated: true } });
      });
      return { now: clockFor(s) };
    }],
    ['GET', /^\/api\/operations\/([\w-]+)$/, (req, m) => getReceipt(db, sessionOf(req), m[1])],
    ['GET', /^\/api\/audit$/, (req) => {
      const s = sessionOf(req);
      return { verify: verifyChain(db, s.sessionId, s.runId), events: auditLog(db, s.sessionId, s.runId).map((r) => ({ seq: r.seq, hash: r.hash, prevHash: r.prev_hash, event: JSON.parse(r.envelope_json) })) };
    }],
    ['POST', /^\/api\/audit\/verify$/, async (req) => {
      const s = sessionOf(req);
      const head = parse(z.strictObject({ runId: Str.optional(), seq: z.number().int().min(0), hash: z.string().regex(/^[0-9a-f]{64}$/) }), await body(req));
      return verifyChain(db, s.sessionId, s.runId, head);
    }],
    ['POST', /^\/api\/decisions\/([\w-]+)\/replay$/, (req, m) => replay(db, sessionOf(req), m[1])],
  ];

  async function handle(req: IncomingMessage, res: ServerResponse) {
    try { await route(req, res); }
    catch (e) { // last line of defence: a malformed request must never take the process down (G2-06)
      if (!res.headersSent) send(res, e instanceof HttpError ? e.status : 400, e instanceof HttpError ? e.body : { error: 'bad request' });
      else res.destroy();
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      try {
        if (!route) throw new HttpError(404, { error: 'no such route' });
        const out = await route[2](req, url.pathname.match(route[1])!, res);
        send(res, 200, out);
      } catch (e) {
        if (e instanceof HttpError) send(res, e.status, e.body);
        else { console.error(e); send(res, 500, { status: 'UNAVAILABLE', error: 'internal error; no decision was made by this request' }); }
      }
      return;
    }
    serveStatic(url.pathname, res);
  }

  return { db, runId, server: createServer((req, res) => { void handle(req, res); }), close: () => db.close() };
}

function send(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(pathname: string, res: ServerResponse) {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, { error: 'malformed URL' }); }
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  let file = join(PUBLIC_DIR, rel || 'index.html');
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || statSync(file).isDirectory()) file = join(PUBLIC_DIR, 'index.html');
  if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('UI not built'); return; }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'",
    'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(readFileSync(file));
}
