# 90-second walkthrough — script (one full decision, end to end)

Every on-screen value comes from the running engine; nothing in the recording is mocked.

| t (s) | Screen / action | Voice-over |
|---|---|---|
| 0–8 | Opens on **The Confidence Trap**: verdict **DEFER** | "An AI agent wants to ship checkout to all of production. It says it's 99% sure. DECIDE says: not yet." |
| 8–20 | Point at the obligations (Monitoring, CI) and "later: human approval" | "Not because of a score. Telemetry is 47 minutes old, and there's no rollback drill for this exact release. Monitoring and CI act next. The release owner can't even be asked yet." |
| 20–28 | *What would change this decision?* | "DECIDE shows what would change the decision, by re-running the same engine on hypotheticals, without pretending they happened." |
| 28–34 | AI proposer card | "And the agent's confidence? We asked a real model, Claude Haiku, the same thing. It said 50%. Same action, same decision. Confidence isn't an input." |
| 34–48 | Click *fresh healthy telemetry*, then *rollback drill passes*, giving **ESCALATE**. *Sit as release owner*, *Approve this snapshot*, giving **EXECUTE** | "Fresh data. A drill passes. Now, and only now, a human approves this exact artifact, this exact evidence, under this policy." |
| 48–56 | *Agent swaps in a different artifact* gives **DEFER**, with revision 2 | "The agent quietly swaps the build. The approval dies, and we're back to waiting." |
| 56–68 | Vendor *Changed bank details*: adjudicate, then *vendor denies*, giving **REFUSE** | "Same engine, payments. Bank details changed by email yesterday. The vendor denies it on a callback. Refuse. Nobody can approve that." |
| 68–78 | Audit trail: *Chain verified*, then *Replay current decision*, giving identical ✓ | "Every decision is hash-chained, and replays identically from its record." |
| 78–90 | *Known failure* scenario, executed, ground-truth panel | "And here's where it breaks: when every monitor is wrong, DECIDE executes too. Fresh, attributable evidence can still be false. That's the next problem." |
