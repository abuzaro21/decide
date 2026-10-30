# Independent review record

DECIDE was built by **Claude Opus 5.5**, the lead engineering agent. **OpenAI Codex (GPT-6.1 Sol, `gpt-6.1-sol`)** reviewed it independently at every acceptance gate:
- one continuous Codex CLI session;
- read-only sandbox;
- each review pinned to an exact commit;
- the serving model was confirmed from the session's runtime metadata.

Codex read the code, ran the tests itself, and wrote its own attack probes. Every blocking finding was fixed with a regression test that reproduces the original probe. Codex then re-confirmed the fix against that probe.

This page is a curated summary. The verdict lines are quoted exactly; the findings are paraphrased. Raw transcripts are kept privately because they contain local environment details.

| Gate | Scope | Commit reviewed | Verdict(s) |
|---|---|---|---|
| Phase 0 | Architecture spec v2.1 and fixtures | planning docs | `BLOCKED — DEP-10 …; DEP-16 …` → **`APPROVED FOR IMPLEMENTATION`** |
| G1 | Core semantics and policy tests | `c7a8119` → `e2aa1d9` | `G1 FAIL — G1-01 through G1-05 …` → **`G1 PASS`** |
| G2 | Transactional execution | `74a2422` → `4f93e54` | `G2 FAIL — G2-01 through G2-07 …` → **`G2 PASS`** |
| G3 | Approvals, adjudication, audit | `4f93e54` → `fa031b5` → `5660417` | `G3 FAIL — G3-01 … G3-04` → `G3 FAIL — R-01 …` → **`G3 PASS`** |
| G4 | Vendor and support domains | `4f93e54` → `fa031b5` → `5660417` | `G4 FAIL — G4-01 … G4-03` → `G4 FAIL — R-01 …` → **`G4 PASS`** |
| G5 | Judge UI truthfulness, previews, adversarial coverage, release | `e994e2d` → `6de3395` | `G5 FAIL — G5-01 …; G5-02 …; G5-03 …` → **`G5 PASS`** |

## What the reviews caught (all fixed, each with a regression test)

**G1**
- A pending CI result masked a verified failed rollback drill.
- A blanket version dependency masked an independent prohibition.
- An unauthorized or invalid adjudication could resolve a monitor conflict.
- Adjudications were not part of the approval snapshot.
- Telemetry was not bound to its observation window.

**G2**
- **Clock:** evaluation time was read before waiting for the database lock.
- **COMMIT ambiguity:** an error during COMMIT was reported as "nothing executed" (now UNCONFIRMED).
- **Rollback-drill bypass:** a claimed starting artifact could sidestep a failed drill.
- **Reseeding:** a session's world could be reseeded without an audit event.
- **Replay:** it did not check stored decisions against the audit chain.
- **Crash:** a malformed URL could crash the server.
- **Receipts:** lookups did not check ownership.

**G3**
- A review command could approve a newer snapshot than the one shown.
- A replayed adjudication command could clear a newer fraud flag.
- An approval could come back to life after a temporary lock.
- A timer reset while its gate was blocked.
- (R-01) The approval bound raw ledger history instead of the exact in-window exposure.

**G4**
- The 90-day callback expiry was not enforced.
- Exposure was a lifetime total, not a rolling 30-day window.
- Changing an email to the same address cleared its ownership.
- Clients could claim model provenance.

**G5**
- A "replayed ✓" badge survived a decision change.
- "What would change" previews did not state their assumptions.
- The known-failure panel contradicted the current evidence.
- Seven gaps in threat-catalogue test coverage were closed.

## What was independently confirmed

Codex confirmed the following itself:
- **Execution:** 20 separate SQLite connections executing one operation produce exactly one effect. Crashes at four points inside the transaction leave all-or-nothing.
- **Approvals:**
  - they are invalidated by any change of action, evidence snapshot, exact exposure, policy, evaluator, role or expiry;
  - stale review and adjudication commands are refused;
  - previews never persist anything.
- **Test runs:** `npm test`, `npm run typecheck` and the Playwright browser suite.

## Limits of this record

- Review is evidence, not proof.
- Codex did not attest the historical model calls that produced the recorded proposer outputs. It checked that the recorded raw outputs match their parsed values and that the recording script takes the model id from runtime metadata.
- See the README's *Where it breaks* section for known limits.
