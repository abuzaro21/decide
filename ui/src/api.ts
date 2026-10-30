// Thin API client. Every value the UI shows comes from these calls; nothing is computed client-side except wording.
export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) { super(body?.error ?? `HTTP ${status}`); this.status = status; this.body = body; }
}

let sessionPromise: Promise<void> | null = null;
let generation = 0;
// Sessions are created one after another: two concurrent POSTs let the older response's Set-Cookie land last,
// so later requests would carry a session that does not own the proposal the caller just created.
export const newSession = () => {
  generation++;
  return (sessionPromise = (sessionPromise ?? Promise.resolve()).catch(() => {})
    .then(() => fetch('/api/session', { method: 'POST' })).then(() => undefined));
};

export async function api<T = any>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  if (!sessionPromise) newSession();
  const gen = generation;
  await sessionPromise;
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if ((res.status === 401 || res.status === 410) && !retried) {
    // Reset at most once per session generation: if a newer session already replaced the one this request ran in
    // (a scenario switch or a concurrent recovery), retry under it instead of replacing it again.
    if (gen === generation) {
      if (res.status === 410) window.dispatchEvent(new CustomEvent('decide:run-restarted', { detail: json }));
      newSession();
    }
    return api(method, path, body, true);
  }
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export interface Gate {
  gateId: string; status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'BLOCKED'; resolver?: 'REQUESTER' | 'EXTERNAL' | 'AUTHORITY' | 'NONE';
  purpose?: 'ADJUDICATE' | 'APPROVE' | 'TIMEOUT'; role?: string; dependsOn: string[]; blockedBy?: string[];
  reasonCode?: string; observed?: any; required?: any; deadlineAt?: number;
}
export interface Decision {
  outcome: 'EXECUTE' | 'ASK' | 'DEFER' | 'ESCALATE' | 'REFUSE'; fingerprint: string; policyName: string; policyHash: string; evaluatorVersion: string;
  gates: Gate[]; obligations: Gate[]; later: Gate[]; rejected: { observationId: string; kind: string; sourceId: string; reason: string }[];
  snapshotRoot: string; preconditions: Record<string, string>; reviewToken: string; approvalChecks: { approvalId: string; reason: string | null }[]; risk: { I: number; B: number; U: number; uUnknown: boolean; tier: string } | null;
  display: {
    agentConfidence: { value: number | null; label: string }; evidenceCoverage: { available: number; required: number };
    provenance: { adapter: number; reviewer: number; requester: number; rejected: number };
    evidenceSupport: string; riskScore: { ordinal: number; of: 4; tier: string; components: string } | null;
  };
}
export interface View {
  proposalId: string; revision: number; status: string; action: { actionType: string; params: Record<string, any>; initiatingPrincipal: string; expectedTargetVersions: Record<string, any> };
  proposer: { kind: string; model?: string; recordedAt?: string; recordingId?: string; agentConfidence?: number; rationale?: string; prompt?: string };
  decisionId: string | null; decision: Decision | null; receipt: any; operationId: string;
}
