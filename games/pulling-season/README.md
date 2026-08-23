# Pulling Season

Pulling Season is a fresh Unity 6 GameFactory project for proving one causal, physical oversized-crop harvest before broader production.

## Current slice

The first slice is deliberately limited to one field, one crop, one approach/grab/pull sequence, a persistent intact-or-damaged crop result, and one visible follow-up decision. It explicitly excludes networking, broad progression, content catalogs, and final art.

The immutable Unity scenario is `contracts/first-session.scenario.json`. Candidate code may change `Assets/**` and `ProjectSettings/**`; it may not change the scenario, package manifest, frozen specification, or factory-owned Unity bridge.

## Commands

```powershell
npm run factory -- spec validate games/pulling-season/game-spec.json --project-id pulling-season
npm run factory -- project doctor games/pulling-season/gamefactory.project.json
npm run factory -- project run games/pulling-season/gamefactory.project.json
```

The project stops for human approval after trusted Unity and Gemini embodied evidence accepts the first playable. A production encounter is planned in the GameSpec but is intentionally not yet executable.
