# DECIDE — The Action Boundary

> An AI agent is allowed to do something. **Should this exact action happen now?** If not, who has to act first?

DECIDE is a deterministic decision layer. It takes a proposed action plus evidence and returns exactly one of **EXECUTE · ASK · DEFER · ESCALATE · REFUSE**. Each decision comes with:

- the gates that fail;
- who must act next;
- what evidence is missing;
- an ordinal risk score (with its derivation);
- what would change the decision.

The AI proposer's own confidence is displayed, but no rule ever reads it.

**Status: early implementation (2026-10-29).** The core evaluator and the DevOps policy are working and tested. Persistence, execution, the API, the UI, and the vendor and support domains are not built yet. Nothing below claims more than the tests show.

## Run

Requires **Node.js 24.13.x** (no other runtime dependencies).

```bash
npm ci
npm test            # node:test, runs .ts natively
npm run typecheck   # tsc --noEmit
npm run spike:sqlite
```

The same in a clean Linux container:

```bash
docker run --rm -v "$PWD:/src:ro" node:24.13.0-slim sh -c \
  "mkdir /w && cd /src && tar --exclude=node_modules -cf - . | tar -xf - -C /w && cd /w && npm ci && npm test && npx tsc --noEmit"
```

## Layout

| Path | What |
|---|---|
| `src/engine.ts` | Pure evaluator: core gates (CONTRACT, FIELDS, AVAIL, VERSIONS), topological gate evaluation with BLOCKED, precedence, timers, strict-snapshot approval validity, bounded "what would change" previews, risk matrix |
| `src/policy/deploy.ts` | `deploy_release` policy (`deploy@cut1`) |
| `src/canonical.ts` | RFC 8785 canonical JSON + SHA-256 |
| `test/` | Golden fixtures and property tests |
| `spike/` | SQLite guarantees spike (results in `evidence/`) |

The design spec lives outside this repo, in the planning workspace (`06-DECISION-SEMANTICS-AND-POLICY-MODEL.md`).
