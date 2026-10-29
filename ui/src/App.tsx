import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, newSession, type Gate, type View } from './api';
import { OUTCOME_COPY, SUPPORT_COPY, actionTitle, actorOf, costOfBeingWrong, roleLabel, sentence, short, EVIDENCE_LABEL } from './text';

type Scenario = { id: string; title: string; domain: string };
type Control = { id: string; label: string; domain: string };
const DOMAIN_LABEL: Record<string, string> = { deploy_release: 'DevOps', pay_vendor_invoice: 'Vendor payment', change_account_email: 'Account email' };
const ROLE_HOLDER: Record<string, string> = { 'release-owner': 'human:rhea', 'eng-director': 'human:omar', 'sre-oncall': 'human:sam', operator: 'human:op', 'ap-manager': 'human:ana', 'finance-controller': 'human:fin', 'security-lead': 'human:sec' };

export function App() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [controls, setControls] = useState<Control[]>([]);
  const [active, setActive] = useState<string>('confidence-trap');
  const [pid, setPid] = useState<string | null>(null);
  const [v, setV] = useState<View | null>(null);
  const [wwc, setWwc] = useState<any>(null);
  const [auditData, setAudit] = useState<any>(null);
  const [replayed, setReplayed] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<'trace' | 'audit'>('trace');

  useEffect(() => {
    api<Scenario[]>('GET', '/api/scenarios').then(setScenarios);
    api<Control[]>('GET', '/api/controls').then(setControls);
    const onRestart = () => setNotice('The demo server restarted, so your previous session and its data are gone (state lives only for one run). A fresh session was started.');
    window.addEventListener('decide:run-restarted', onRestart);
    return () => window.removeEventListener('decide:run-restarted', onRestart);
  }, []);

  const refresh = useCallback(async (id: string, latest?: View) => {
    const view = latest ?? await api<View>('GET', `/api/proposals/${id}`);
    setV(view);
    setWwc(view.status === 'OPEN' && view.decision?.outcome !== 'EXECUTE' ? await api('GET', `/api/proposals/${id}/what-would-change`) : null);
    setAudit(await api('GET', '/api/audit'));
  }, []);

  const run = useCallback(async (fn: () => Promise<View | void>) => {
    setBusy(true); setErr(null);
    try { const out = await fn(); if (pid) await refresh(pid, out || undefined); }
    catch (e) { setErr(e instanceof ApiError ? `${e.status}: ${e.message}${e.body?.status ? ` (${e.body.status})` : ''}` : String(e)); if (pid) await refresh(pid).catch(() => {}); }
    finally { setBusy(false); }
  }, [pid, refresh]);

  const load = useCallback(async (id: string) => {
    setBusy(true); setErr(null); setReplayed(null);
    try {
      await newSession();
      const { proposalId } = await api<{ proposalId: string }>('POST', `/api/scenarios/${id}`);
      setActive(id); setPid(proposalId);
      await refresh(proposalId);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }, [refresh]);

  useEffect(() => { load('confidence-trap'); }, [load]);

  const d = v?.decision;
  const outcome = v?.status === 'CLOSED_EXECUTED' ? 'EXECUTE' : d?.outcome;
  const domainControls = useMemo(() => controls.filter((c) => c.domain === v?.action.actionType), [controls, v]);
  const open = v?.status === 'OPEN';
  const reviewGate = d?.obligations.find((g) => g.purpose);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden>D</span>
          <div><h1>DECIDE</h1><p>The action boundary — should this exact action happen now?</p></div>
        </div>
        <nav className="scenarios" aria-label="Scenarios">
          {scenarios.map((s) => (
            <button key={s.id} className={`chip ${s.id === active ? 'on' : ''}`} onClick={() => load(s.id)} disabled={busy}>
              <span className="chip-domain">{DOMAIN_LABEL[s.domain] ?? s.domain}</span>{s.title.split(' — ')[0]}
            </button>
          ))}
        </nav>
      </header>
      {notice && <div className="banner" role="status">{notice} <button onClick={() => setNotice(null)}>Dismiss</button></div>}
      {err && <div className="banner bad" role="alert">{err}</div>}

      {v && d && (
        <main className="grid">
          <section className="col-main">
            <article className="card proposal">
              <div className="eyebrow">Proposed by {v.action.initiatingPrincipal} <Provenance v={v} /></div>
              {v.proposer.rationale && <blockquote>“{v.proposer.rationale}”</blockquote>}
              <h2>{actionTitle(v)}</h2>
              <div className="confidence-claim">
                <strong>Agent says {v.proposer.agentConfidence !== undefined ? `${Math.round(v.proposer.agentConfidence * 100)}%` : '—'} sure.</strong> Untrusted self-report: no gate reads it, and changing it cannot change this decision.
              </div>
              <div className="meta">revision {v.revision} · {v.status.replace('_', ' ').toLowerCase()} · fingerprint <code>{short(d.fingerprint)}</code></div>
            </article>

            <article className={`card verdict o-${outcome}`} aria-live="polite">
              <div className="verdict-head">
                <div className="verdict-word">{outcome}</div>
                <div className="verdict-next">{v.status === 'CLOSED_EXECUTED' ? 'Executed exactly once. The receipt below is the permanent record.' : OUTCOME_COPY[d.outcome].next}</div>
              </div>
              {v.status !== 'CLOSED_EXECUTED' && d.obligations.length > 0 && (
                <ul className="why">{d.obligations.map((g) => <li key={g.gateId}><span className="actor">{actorOf(g)}</span><span>{sentence(g, v)}{g.deadlineAt ? <em className="deadline"> Waits until {new Date(g.deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, then escalates to an operator.</em> : null}</span></li>)}</ul>
              )}
              {d.later.length > 0 && v.status === 'OPEN' && (
                <p className="later"><strong>Later, once those clear:</strong> {laterSummary(d.later)}</p>
              )}
              <NextStep v={v} busy={busy} onExecute={() => run(() => api('POST', `/api/proposals/${v.proposalId}/revisions/${v.revision}/execute`).then(() => undefined))} />
              {v.receipt && <Receipt r={v.receipt} />}
            </article>

            {wwc && (wwc.single?.length > 0) && (
              <article className="card wwc">
                <h3>What would change this decision?</h3>
                <p className="hint">The same evaluator re-run on hypothetical fixes. Preview only: it creates no evidence, approval or effect.</p>
                <ul>
                  {wwc.single.map((x: any) => <li key={x.gateId}><span>{repairLabel(x)}</span><Badge o={x.outcome} />{x.remaining.length > 0 && <small>still open: {x.remaining.map(niceGate).join(', ')}</small>}</li>)}
                  {wwc.combined && <li className="combined"><span>If all of the above</span><Badge o={wwc.combined.outcome} />{wwc.combined.remaining.length > 0 && <small>still open: {wwc.combined.remaining.map(niceGate).join(', ')}</small>}</li>}
                </ul>
              </article>
            )}

            <section className="card lower">
              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={tab === 'trace'} className={tab === 'trace' ? 'on' : ''} onClick={() => setTab('trace')}>Gate trace</button>
                <button role="tab" aria-selected={tab === 'audit'} className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>Audit trail {auditData?.verify?.ok ? '✓' : ''}</button>
              </div>
              {tab === 'trace' ? <Trace d={d} /> : <Audit a={auditData} decisionId={v.decisionId} replayed={replayed}
                onReplay={async () => setReplayed(await api('POST', `/api/decisions/${v.decisionId}/replay`))} />}
            </section>
          </section>

          <aside className="col-side">
            <article className="card signals">
              <h3>What this decision rests on</h3>
              <Signal label="Evidence" value={`${d.display.evidenceCoverage.available}/${d.display.evidenceCoverage.required} required sources`} note={`${SUPPORT_COPY[d.display.evidenceSupport] ?? d.display.evidenceSupport}. Deterministic count, not a probability.`} />
              <Signal label="Provenance" value={`${d.display.provenance.adapter} from systems · ${d.display.provenance.requester} requester-asserted`} note={d.display.provenance.rejected ? `${d.display.provenance.rejected} observation(s) rejected at admission: ${[...new Set(d.rejected.map((r) => r.reason.toLowerCase().replace(/_/g, ' ')))].join(', ')}` : 'Nothing rejected'} />
              <Signal label="Risk score" value={d.display.riskScore ? `${d.display.riskScore.ordinal}/4 · ${d.display.riskScore.tier}` : '—'} note={d.display.riskScore ? `${d.display.riskScore.components} — consequence·breadth·recovery through a published matrix. Ordinal heuristic.` : 'Not computed until the proposal is complete'} />
              <Signal label="Reversibility" value={d.risk ? (d.risk.uUnknown ? 'Unknown — treated as irreversible' : ['No effect', 'Restorable (verified)', 'Compensable', 'Irreversible'][d.risk.U]) : '—'} />
              <Signal label="Cost of being wrong" value={costOfBeingWrong(v)} />
              <Signal label="Policy" value={d.policyName} note={`hash ${short(d.policyHash.split(':')[1] ?? d.policyHash)} · evaluator ${d.evaluatorVersion}`} />
            </article>

            {open && reviewGate && <ReviewSeat v={v} g={reviewGate} busy={busy} run={run} />}

            {open && domainControls.length > 0 && (
              <article className="card world">
                <h3>Change the world <span className="sim">simulated</span></h3>
                <p className="hint">These are external systems publishing new facts. Evidence is collected from them. None of them can approve anything.</p>
                <div className="controls">
                  {domainControls.map((c) => <button key={c.id} disabled={busy} onClick={() => run(() => api('POST', `/api/proposals/${v.proposalId}/world`, { control: c.id }))}>{c.label}</button>)}
                  <button disabled={busy} onClick={() => run(async () => { await api('POST', '/api/clock', { advanceMinutes: 16 }); })}>Advance the clock 16 minutes</button>
                  {v.action.actionType === 'deploy_release' && <button className="ghost" disabled={busy} onClick={() => run(() => api('POST', `/api/proposals/${v.proposalId}/evidence`, { kind: 'telemetry', sourceId: 'apm', subject: { service: v.action.params.service, env: v.action.params.environment, windowSec: 300 }, value: { errorRatePct: 0, p95Ms: 1 } }))}>Agent submits its own “apm says healthy” reading</button>}
                  {v.action.actionType === 'deploy_release' && <button className="ghost" disabled={busy} onClick={() => run(() => api('POST', `/api/proposals/${v.proposalId}/revisions`, { params: { ...v.action.params, toArtifact: 'sha256:a1e7' }, proposer: { kind: 'MANUAL', agentConfidence: 0.99, rationale: 'Tiny hotfix on top, same thing really.' } }).then(async (r: any) => { await refresh(v.proposalId); return undefined; }))}>Agent swaps in a different artifact</button>}
                </div>
              </article>
            )}
          </aside>
        </main>
      )}
      <footer className="foot">Deterministic decisions · SQLite transactional simulator · every value on this page comes from the engine's decision record. Demo identities are simulated.</footer>
    </div>
  );
}

function laterSummary(later: Gate[]) {
  const appr = later.some((g) => g.gateId.endsWith('APPROVE'));
  const checks = later.filter((g) => !g.gateId.endsWith('APPROVE')).length;
  return [checks ? `${checks} dependent check${checks > 1 ? 's' : ''} re-run on the new evidence` : '', appr ? 'then, if risk requires it, a named human approves the exact snapshot' : ''].filter(Boolean).join(' — ');
}
function repairLabel(x: { gateId: string; label: string }) {
  if (x.gateId.startsWith('AVAIL(')) return `If fresh, acceptable ${EVIDENCE_LABEL[x.gateId.slice(6, -1)] ?? x.gateId} arrived`;
  if (x.gateId.endsWith('APPROVE')) return 'If the required reviewer approved this exact snapshot';
  return `If ${niceGate(x.gateId)} were resolved`;
}
const niceGate = (id: string | Gate) => {
  const g = typeof id === 'string' ? id : id.gateId;
  if (g.endsWith('APPROVE')) return 'human approval';
  return g.startsWith('AVAIL(') ? EVIDENCE_LABEL[g.slice(6, -1)] ?? g : g.replace(/^[A-Z]-/, '').toLowerCase().replace(/-/g, ' ');
};

function Provenance({ v }: { v: View }) {
  const p = v.proposer;
  if (p.kind === 'LIVE_LLM') return <span className="prov live">live model · {p.model}</span>;
  if (p.kind === 'RECORDED_LLM') return <span className="prov rec">recorded model output · {p.model} · {p.recordedAt?.slice(0, 10)}</span>;
  return <span className="prov man">scripted scenario</span>;
}

function Badge({ o }: { o: string }) { return <span className={`badge o-${o}`}>{o}</span>; }

function Signal({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="signal"><div className="sig-label">{label}</div><div className="sig-value">{value}</div>{note && <div className="sig-note">{note}</div>}</div>;
}

function NextStep({ v, busy, onExecute }: { v: View; busy: boolean; onExecute: () => void }) {
  if (v.status === 'SUPERSEDED') return <p className="next">This revision was superseded by a newer one.</p>;
  if (v.status !== 'OPEN') return null;
  if (v.decision?.outcome === 'EXECUTE') return <button className="primary" disabled={busy} onClick={onExecute}>Execute — re-validates inside one transaction</button>;
  return null;
}

function Receipt({ r }: { r: any }) {
  return <div className="receipt"><div className="eyebrow">Receipt</div><code>{r.operationId}</code><div>{Object.entries(r.effect ?? {}).map(([k, val]) => `${k}: ${val}`).join(' · ')}</div><small>decision {short(r.decisionId)} {r.approvalId ? `· approval ${short(r.approvalId)}` : ''}</small></div>;
}

function ReviewSeat({ v, g, busy, run }: { v: View; g: Gate; busy: boolean; run: (fn: () => Promise<View | void>) => void }) {
  const d = v.decision!;
  const role = g.purpose === 'APPROVE' ? String(g.required) : String(g.role);
  const who = ROLE_HOLDER[role];
  const base = `/api/proposals/${v.proposalId}/revisions/${v.revision}`;
  return (
    <article className="card seat">
      <h3>Sit as {roleLabel(role)} <span className="sim">simulated identity · {who}</span></h3>
      {g.purpose === 'APPROVE' && (<>
        <p className="hint">You are approving this exact snapshot. If the action, the evidence, the policy or the risk changes, this approval dies.</p>
        <dl className="bound">
          <dt>Action</dt><dd><code>{short(d.fingerprint)}</code></dd>
          <dt>Evidence snapshot</dt><dd><code>{short(d.snapshotRoot)}</code></dd>
          <dt>Policy</dt><dd><code>{d.policyName}</code></dd>
          <dt>Risk</dt><dd>{d.risk?.tier} ({d.display.riskScore?.components})</dd>
        </dl>
        <div className="row"><button className="primary" disabled={busy} onClick={() => run(() => api('POST', `${base}/review`, { approverId: who, verdict: 'APPROVE' }))}>Approve this snapshot</button>
          <button className="danger" disabled={busy} onClick={() => run(() => api('POST', `${base}/review`, { approverId: who, verdict: 'REJECT' }))}>Reject</button></div>
      </>)}
      {g.purpose === 'ADJUDICATE' && (<>
        <p className="hint">Choose which existing reading to trust, or reject the proposal. You cannot invent a healthy reading.</p>
        <div className="controls">{(g.observed?.candidates ?? []).map((c: any) => <button key={c.observationId} disabled={busy} onClick={() => run(() => api('POST', `${base}/adjudicate`, { actor: who, gateId: g.gateId, decision: 'SELECT_OBSERVATION', selection: c.observationId }))}>Trust {c.source}: {c.errorRatePct}% errors, p95 {c.p95Ms} ms</button>)}
          <button className="danger" disabled={busy} onClick={() => run(() => api('POST', `${base}/adjudicate`, { actor: who, gateId: g.gateId, decision: 'REJECT' }))}>Reject the proposal</button></div>
      </>)}
      {g.purpose === 'TIMEOUT' && (<>
        <p className="hint">The deadline passed. You may extend once or cancel. You cannot mark the evidence as present.</p>
        <div className="row"><button disabled={busy} onClick={() => run(() => api('POST', `${base}/adjudicate`, { actor: who, gateId: g.gateId, decision: 'EXTEND_ONCE' }))}>Extend once</button>
          <button className="danger" disabled={busy} onClick={() => run(() => api('POST', `${base}/adjudicate`, { actor: who, gateId: g.gateId, decision: 'CANCEL' }))}>Cancel</button></div>
      </>)}
    </article>
  );
}

function Trace({ d }: { d: View['decision'] & {} }) {
  return (
    <table className="trace">
      <thead><tr><th>Gate</th><th>Status</th><th>Who clears it</th><th>Detail</th></tr></thead>
      <tbody>{d.gates.map((g) => (
        <tr key={g.gateId} className={`s-${g.status}`}>
          <td><code>{g.gateId}</code></td><td>{g.status.replace('_', ' ')}</td>
          <td>{g.status === 'FAIL' ? `${actorOf(g)}${g.purpose ? ` · ${g.purpose.toLowerCase()}` : ''}` : ''}</td>
          <td>{g.status === 'BLOCKED' ? `waits on ${g.blockedBy?.join(', ')}` : g.reasonCode ?? ''}</td>
        </tr>))}</tbody>
    </table>
  );
}

function Audit({ a, decisionId, replayed, onReplay }: { a: any; decisionId: string | null; replayed: any; onReplay: () => void }) {
  if (!a) return null;
  return (
    <div className="audit">
      <div className="audit-head">
        <span className={a.verify.ok ? 'ok' : 'bad'}>{a.verify.ok ? `Chain verified · ${a.verify.length} events` : `Chain broken at ${a.verify.at}: ${a.verify.reason}`}</span>
        {a.verify.ok && <code title="Copy this head; a later export must extend it">head {a.verify.head.seq}:{short(a.verify.head.hash)}</code>}
        {decisionId && <button onClick={onReplay}>Replay current decision</button>}
        {replayed && <span className={replayed.identical ? 'ok' : 'bad'}>{replayed.replayable ? (replayed.identical ? 'Replayed: identical ✓' : 'Replay differs ✗') : replayed.reason}</span>}
      </div>
      <ol className="events">{[...a.events].reverse().map((e: any) => (
        <li key={e.seq}><span className="seq">#{e.seq}</span><span className="etype">{e.event.type.replace(/_/g, ' ').toLowerCase()}</span><span className="eactor">{e.event.actor}</span>
          {e.event.payload?.outcome && <Badge o={e.event.payload.outcome} />}<code className="hash">{e.hash.slice(0, 10)}</code></li>))}</ol>
    </div>
  );
}
