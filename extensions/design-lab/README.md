# Design Lab extension

Design Lab keeps player-experience intent and synthetic playtesting outside the kernel.

- `evaluator:design.intent` verifies a versioned, canonically hashed design intent.
- `evaluator:playtest.agents` runs its configured scripted personas across every scenario and seed using a registered engine-neutral `ScenarioRunner`.
- `evaluator:playtest.human` ingests a consent-aware, design-pinned human study report. Missing evidence is `inconclusive`; personal-data-marked reports are never preserved.

These are synthetic playtests. They are useful for behavior, balance, reachability, exploits, pacing proxies, and regressions. They are not evidence that a game is fun, understandable, emotionally effective, or accessible to a particular human population. Calibrate persona behavior and automated thresholds against real playtests.
