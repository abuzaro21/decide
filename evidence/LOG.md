# Evidence log

Each entry records what was actually run and what happened. Claims elsewhere point here.

## 2026-10-29 — SQLite binding spike

- Command: `npm run spike:sqlite` (Windows). Linux run: `docker run --rm -v "$PWD/spike:/spike:ro" node:24.13.0-slim node /spike/sqlite-spike.mjs`
- Result: 6/6 checks on both platforms, Node v24.13.0, `node:sqlite`. See `sqlite-spike-windows.json` and `sqlite-spike-linux.json`. The Linux image digest is `sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f`.
- Checks:
  - a UNIQUE operation id blocks a duplicate effect;
  - rollback undoes effect and audit together;
  - `BEGIN IMMEDIATE` serializes a second writer;
  - triggers make audit append-only;
  - CHECK rejects HYPOTHETICAL rows;
  - committed data survives reopen.
- Decision: use `node:sqlite`. `better-sqlite3` is not added. Caveat: `node:sqlite` is marked experimental on Node 24.13 (it prints an ExperimentalWarning, which is suppressed in npm scripts). It is pinned through `engines` and the Docker tag.

## 2026-10-29 — Core evaluator tests

- Commands: `npm test` and `npm run typecheck`. The Linux clean-copy run uses the `docker run … npm ci && npm test && npx tsc --noEmit` command from the README.
- `c7a8119`: 24/24 pass, typecheck clean, on both Windows and Linux.
- `e2aa1d9`, after fixing Codex G1-01…05: 31/31 pass, typecheck clean (Windows).

## 2026-10-29 — Hosting feasibility (read-only, nothing created)

- `render whoami` and `render workspaces` show the CLI is authenticated, with one workspace ("My Workspace"). That workspace already holds Agent Trust's free web service and its free Redis. Both were left untouched.
- Render free tier, per https://render.com/docs/free fetched 2026-10-29:
  - 750 instance-hours per month **per workspace** (shared with Agent Trust);
  - spins down after 15 minutes idle, then takes about 1 minute to cold-start;
  - ephemeral filesystem, no persistent disk on free services.
- Fit: DECIDE's ephemeral-run design matches this (each boot gets a new `runId`, and ids from an old run return 410). Deploying still needs its own release check and owner go-ahead.

## 2026-10-29 — Agent Trust boundary check (read-only)

- The local Agent Trust checkout is at `4c25b4b` with a clean tree.
- `git ls-remote origin refs/heads/main` returns `c389390dae5d08fd749058850138b059dfbfe2db`.
- So the local checkout is stale. It is **not** the release. Nothing was fetched, modified or deployed.

## 2026-10-29 — Codex verification (session `01a18922-b03c-76c0-bae4-15922c7eb4f3`, `gpt-6.1-sol`, high, read-only)

Transcripts are in `decision-engine-planning/codex-sessions/phase0/`. Codex ran the commands itself in its read-only sandbox.

| Step | Verdict |
|---|---|
| Phase 0, v2.1 docs | **BLOCKED**. Two fixture defects: DEP-10 one-monitor red gives ESCALATE, not DEFER; DEP-16 calendar expiry. Fixed in `07`/`08`. |
| Phase 0 re-check | **APPROVED FOR IMPLEMENTATION** |
| G1, code at `c7a8119` | **FAIL**. G1-01…05 reproduced with real probes. All fixed in `e2aa1d9`, each with a regression test. |
| G1 re-confirmation, `e2aa1d9` | **G1 PASS**. Codex ran `npm test`: 31/31. `tsc --noEmit` passed. |

Carried forward to G2/G3 (non-blocking):
- a persisted-adjudication command validator (allowed commands, applicability, extension limits);
- timer clearing;
- terminal cancellation;
- OPEN/current revision checks;
- rejection of preview persistence.

## 2026-10-30 — Container cold start and run reset (local Docker, nothing deployed)

- `docker build -t decide:local .`: 337 MB image (node:24.13.0-slim). Runs as the unprivileged `node` user.
- Cold start to a healthy `/api/health` response: **1667 ms**. A Render free instance adds its own wake-up of about 1 minute.
- `docker restart` gives a new `runId`. The old session cookie then gets `410 "this demo run was restarted…"`, so nothing implies persistence across restarts.

## 2026-10-30 — Gates G2–G4 (Codex `gpt-6.1-sol`, same session, read-only, pinned commits)

Transcripts are in `decision-engine-planning/codex-sessions/gates/`.

| Gate | Round 1 | Fixes | Final |
|---|---|---|---|
| G2 transactional execution | FAIL at `74a2422`: G2-01…07 (stale clock under lock contention, COMMIT ambiguity, rollback-drill bypass via claimed fromArtifact, unaudited reseed, replay not bound to audit, server crash on `/%`, receipt ownership) | `4f93e54` | **G2 PASS** (re-confirmed against Codex's original probes) |
| G3 approvals/adjudication/audit | FAIL at `4f93e54`: G3-01…04 (stale consent, stale adjudication command, approval resurrection, timer reset while BLOCKED) | `fa031b5` | FAIL (R-01: exposure binding hashed raw history), fixed `5660417`, **G3 PASS** |
| G4 vendor + support domains | FAIL at `4f93e54`: G4-01…03 (90-day callback cap, rolling exposure, same-address ownership) | `fa031b5` | FAIL (R-01), fixed `5660417`, **G4 PASS** |

Every blocking finding has a regression test.

## 2026-10-30 — Clean-clone qualification (fresh `node:24.13.0-slim` container, `git clone` of `5660417`)

- `npm ci`, then `npm run build`, then `npm test`: **88/88**. `npm run typecheck`: OK.
- `npm start` was healthy after 2.3 s and served the UI. The Confidence Trap scenario returned **DEFER**.
- GitHub Actions on `5660417`: ubuntu + windows verify green; Linux Playwright **7/7**.

## 2026-10-30 — Gate G5 (judge experience, previews, adversarial assurance, release qualification)

| Round | Verdict |
|---|---|
| G5 at `e994e2d` | **FAIL**. G5-01 stale replay assurance; G5-02 preview wording hid assumptions; G5-03 the known-failure panel contradicted changed evidence. Plus non-blocking G5-04…08 and gaps in the threat-catalogue tests. |
| G5 re-check at `6de3395` | **G5 PASS**. Codex ran `npm test` 94/94, typecheck and Playwright 9/9 itself. |
| Follow-up | Non-blocking wording branch (approved but not yet executed) fixed; T-20 concurrent distinct-invoice test added (95/95). |

**All acceptance gates G1–G5: PASS.**
