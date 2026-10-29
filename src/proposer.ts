// The AI component: an LLM turns a natural-language request into a typed proposal and self-reports confidence.
// Its output is UNTRUSTED input to the engine: it is schema-validated, its confidence is displayed but never read by
// any gate, and free text (including injected "approvals") is stored only as rationale.
import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export const PROPOSER_MODEL = 'claude-haiku-5-5';

export const PROPOSER_SYSTEM = `You are an operations agent. Convert the user's request into ONE proposed action for an execution gateway.
Allowed actions and their params (use exactly these keys; omit a key if the request does not say it):
- deploy_release: { service: string, environment: "dev"|"staging"|"prod", toArtifact: string, fromArtifact: string, trafficPercent: integer 0-100, intent: "ROUTINE"|"INCIDENT_REMEDIATION" }
- pay_vendor_invoice: { vendorId: string, invoiceId: string, amountCents: integer, currency: string (ISO 4217), rail: "ACH"|"WIRE" }
- change_account_email: { accountId: string, ticketId: string, newEmail: string }
Reply with ONLY a JSON object: {"actionType": string, "params": object, "agentConfidence": number between 0 and 1 (how sure you are this action should run now), "rationale": string (one or two sentences)}.`;

const Out = z.object({ actionType: z.string(), params: z.record(z.string(), z.unknown()), agentConfidence: z.number().min(0).max(1), rationale: z.string().max(2000) });
export type ProposerOutput = z.infer<typeof Out>;

/** Parse model text into the typed proposal shape. Throws on anything else — the engine never sees unparsed model output. */
export function parseProposal(text: string): ProposerOutput {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('proposer returned no JSON object');
  return Out.parse(JSON.parse(m[0]));
}

export interface Recording {
  recordingId: string; scenarioId: string; model: string; recordedAt: string; via: string; cliSessionId?: string;
  request: string; system: string; rawOutput: string; parsed: ProposerOutput;
}

const DIR = new URL('../fixtures/proposals/', import.meta.url);
export function loadRecordings(): Recording[] {
  try { return readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) as Recording); }
  catch { return []; }
}

/** Optional live mode: only when ANTHROPIC_API_KEY is configured. Never required for the demo or the tests. */
export async function proposeLive(request: string, apiKey: string): Promise<{ model: string; raw: string; parsed: ProposerOutput }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: PROPOSER_MODEL, max_tokens: 600, system: PROPOSER_SYSTEM, messages: [{ role: 'user', content: request }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`proposer API ${res.status}`);
  const body = await res.json() as { model: string; content: { type: string; text?: string }[] };
  const raw = body.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  return { model: body.model, raw, parsed: parseProposal(raw) };
}
