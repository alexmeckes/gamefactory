# Design discovery and playtesting

GameFactory separates creative intent, synthetic behavioral evidence, and human experience evidence. They answer different questions and must not be collapsed into one score.

```mermaid
flowchart LR
  B["Ordinary game idea + intake choices"] --> I["Versioned design intent"]
  I --> D["Divergent prototypes"]
  D --> A["Synthetic player cohort"]
  A --> R["Ranked recommendation"]
  R --> H["Human playtest"]
  H --> P["Human report gate"]
  P --> O["Measured optimization"]
  O --> S["Ship review"]
```

## Initial intake

The user begins with an ordinary description, not a completed game design document. `intake:game.design` asks five pointed multiple-choice questions about experience emphasis, core-activity certainty, play shape, creative freedom, and the first learning goal.

Every question includes **Figure it out**. Selecting it records an explicit delegated decision in `gamefactory.game-brief/v1`; downstream agents must explore alternatives and preserve their hypothesis reasoning. It is not replaced by a canned default.

Questions describe consequential creative choices rather than a mechanic inventory. The resulting `game.brief.json` is input to design-intent drafting and prototype discovery:

```sh
gamefactory intake "A compact game about impossible architecture" --output game.brief.json
```

## Design intent

`@gamefactory/design-sdk` defines `gamefactory.design/v1`. A design intent records:

- audience needs and exclusions;
- player fantasy, desired emotions, pillars, and anti-pillars;
- core verbs, loop, and expected session length;
- predicted dynamics and intended-experience hypotheses, with an optional mechanic when one is actually being tested;
- hard creative boundaries, soft preferences, explicitly free exploration space, and open design questions;
- synthetic personas, scenarios, seeds, and statistical quality bars;
- accessibility, performance, and platform constraints;
- unresolved questions that require more evidence.

Campaigns pin the intent by path, ID, version, and canonical JSON SHA-256. `evaluator:design.intent` verifies that contract before more expensive work runs. Changing a pillar, creative boundary, exploration question, hypothesis, persona, scenario, or quality bar requires a version bump and re-baseline.

Use the constraint ladder deliberately:

- `mustPreserve` is the small set of non-negotiable identity, safety, platform, or production boundaries.
- `preferences` communicates taste and direction, but an agent may violate one when it has a stronger hypothesis and records why.
- `freeToExplore` names systems the agent owns. It should permit genuinely different mechanics, not just numeric tuning.
- `explorationQuestions` describe what the team wants to learn without specifying the answer.

Pillars should describe the experience; they should not smuggle in an implementation. Automated tests are falsification probes and regression alarms—not solution recipes or a surrogate for taste.

## Discovery before optimization

`workflow:discovery` compares deliberately different prototypes without requiring them to be local improvements over the current build. It runs candidates concurrently, evaluates them against the same intent, and ranks passing evidence. Each candidate receives its slot and a creative-space directive through candidate metadata; the agent still chooses the hypothesis and implementation.

The default mode is `selection: "recommend"`. It preserves each prototype's agent evidence, evaluator artifacts, and Git patch, then discards every candidate worktree. A configurable `shortlistCount` preserves several viable directions; rank one is only the strongest configured proxy signal, not the objectively correct design. Nothing is silently merged.

`selection: "accept"` exists for low-risk fixtures. It accepts exactly one recommendation and still requires every configured hard and human gate to pass.

## Agents as synthetic playtesters

`evaluator:playtest.agents` treats a playtester as a behavior policy, not as an implementation agent. It cannot modify the candidate. Each persona is combined with every configured scenario and seed, then executed through an engine-neutral `ScenarioRunner`.

The evaluator reports:

- run, persona, scenario, and seed coverage;
- pass and crash rates;
- mean, minimum, maximum, percentile, and standard-deviation aggregates;
- per-persona means for every declared metric;
- hard quality-bar violations;
- raw telemetry, frames, logs, and a structured cohort report.

The first implementation uses scripted policies inside the Godot scene. The same contract can later carry search-based, reinforcement-learning, or vision/action policies through separate lightweight runner extensions.

Synthetic players are strong evidence for reachability, balance distributions, exploits, pacing proxies, performance, and regressions. They are not evidence of delight, confusion, perceived fairness, emotional pacing, accessibility lived experience, or market appeal. Calibrate persona behavior and automated thresholds against real player traces.

Keep the visible automated suite broad and resistant to trivial gaming. Rotate seeds and scenarios, preserve qualitative traces, and use holdout or human evaluation for decisions that matter. An implementation agent should know the experience intent and guardrails, but should not be instructed to maximize one metric at the expense of unexplored design space.

## Human evidence

`evaluator:playtest.human` reads `gamefactory.human-playtest/v1` reports. A report is pinned to the design-intent hash and includes its subject, method, participant count, audience match, consent state, findings, and an explicit approve/reject/needs-changes decision.

Missing reports are `inconclusive`, so they cannot satisfy a campaign `humanGates` entry. Reports marked as containing personal data are rejected without being copied into the artifact store. This format is meant for summarized, consented research evidence—not interview transcripts or participant identities.

Human gates and `acceptance.hardGates` are enforced by both autoresearch and tournament workflows. Gate values are evaluator IDs:

```json
{
  "acceptance": {
    "primaryMetric": "scenario_score.mean",
    "direction": "maximize",
    "hardGates": ["design.intent", "playtest.agents"]
  },
  "humanGates": ["playtest.human"]
}
```

Because a human cannot review a new autonomous candidate instantaneously, the recommended production flow is two-stage:

1. Run discovery in recommendation mode and inspect the preserved prototype patch and cohort evidence.
2. Apply the selected direction to a review build, conduct the study, add its summarized report, and run a promotion campaign with `playtest.human` as a required gate.

## Pulse Runner demonstration

`examples/godot/design.intent.json` defines three pillars, explicit creative freedom, open questions, two experience hypotheses, three synthetic personas, two scenarios, two seeds, and six quality-bar aggregates. `campaign.discovery.json` creates three contrasting prototypes, runs 36 actual Godot playtests, and preserves a two-direction shortlist.

The included `tools/discover.mjs` is a deterministic smoke-test fixture, so its three variations are intentionally scripted. A production agent should read the same intent, originate its own hypothesis, record the rationale, and use evaluator results as evidence rather than as an objective function.

```powershell
$env:GODOT_BINARY = "C:\path\to\godot_console.exe"
npm run smoke:godot:discovery
```

The metric is deliberately named `scenario_score`, not `fun_score`. It is a behavioral proxy. Fun remains a question for players.
