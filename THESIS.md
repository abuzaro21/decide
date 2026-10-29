# Two-year thesis — confidence is the wrong currency for letting agents act

Our bet: by late 2028, most consequential software actions (deploys, payments, account changes) will be *proposed* by agents. Even as scoped credentials and delegation become standard plumbing, the costly failures will come from authorized agents acting **at the wrong moment, on stale or unverified context, with nobody owning the gap**.

Today's guardrails answer with scores and approval buttons. A score hides which fact is missing. An approval button asks a human to bless a snapshot that changes before execution. We expect three shifts:

1. **Decisions become obligations.** A blocked action will name who acts next (requester, system or role), what fact they owe, and by when. "Who acts next" becomes a field orchestrators route on, as they route on HTTP status codes today.

2. **Approvals become bounded contracts.** Immutable facts (the artifact, the payee account, the policy version) stay bound exactly. New observations must stay inside conditions the human explicitly accepted, until an expiry. "I approved it" becomes something an auditor can replay.

3. **Evidence carries provenance and a shelf life.** Monitors, ledgers and identity systems will publish attributable, time-limited evidence, because decision layers will refuse anything older.

The uncomfortable corollary: **fresh, attributable evidence can still be false.** When every monitor is wrong, the gate opens. The next frontier is therefore not smarter pre-action scoring. It is *independent outcome evidence*: decisions that carry obligations past execution and get checked against signals the acting system does not control.

**Falsifiable test:** a decision layer earns its place only if, measured separately, it reduces unsupported actions *and* unnecessary human interruptions. Calibrated risk models will arrive where outcome data exists. They will tune thresholds, never replace hard constraints.
