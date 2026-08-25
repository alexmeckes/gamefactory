# Pulling Season

Pulling Season is a Unity 6 GameFactory project for building one deep, physical oversized-crop harvest through a gameplay Gauntlet and then an authored production Gauntlet.

## Current slice

The first slice remains deliberately limited to one field and one crop, but it is no longer accepted merely because automation can complete it. Two coherent gameplay candidates are developed in isolated worktrees. Each candidate uses parallel specialists for game direction, controls, physical feedback, and onboarding; one protected integrator owns its Unity revision; trusted evidence captures it; independent critics attack causality, first-minute clarity, and gameplay depth; and one judge issues a bounded repair brief. The selected candidate then stops for direct human play approval.

The second slice begins only after that human approval. It approves a whole-screen target before asset work, fans out environment, crop, motion/audio, and interface direction, integrates through one protected Unity owner, and runs fresh gameplay regression plus harsh production reviews. Accepted upstream gameplay is checkpointed; a late visual defect repairs production, while genuine product invalidation returns through an explicit spec-amendment path.

The immutable v3 Unity scenarios use recognizable shipping input boundaries: forward movement, mouse interaction, backward or lateral correction, and acknowledgement. They are causal and regression evidence, not a substitute for a person deciding whether the controls make sense.

## Commands

```powershell
npm run factory -- spec validate games/pulling-season/game-spec.json --project-id pulling-season
npm run factory -- project doctor games/pulling-season/gamefactory.project.json
npm run factory -- project run games/pulling-season/gamefactory.project.json
```

The project stops for human approval after the gameplay Gauntlet and again after the production Gauntlet. See [the reusable Gauntlet contract](../../docs/gauntlet.md) for the orchestration rationale.
