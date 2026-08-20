---
name: integrate-game-assets
description: Integrate target-linked art, UI, animation, audio, and effects into a real game-engine slice with correct imports, runtime consumers, states, scale, provenance, and captured evidence. Use after approved scene targets or asset production, when placeholders or procedural surfaces remain, or when generated assets exist but the running game does not match them. Do not use to invent an unproven visual direction.
---

# Integrate Game Assets

Treat the running scene as the deliverable. Asset files are inputs, not proof of completion.

## Build the integration map

1. Read the slice contract, approved scene-target hash, component map, design tokens, and asset provenance.
2. Inventory every required component by runtime consumer, state, native size, pivot, anchor, layer, collision or interaction role, and fallback currently in use.
3. Classify each component as authored raster, animation, audio, effect, or deliberately code-native UI. Code-native elements must still implement the approved visual system.
4. Reject orphan assets, untracked target substitutions, and arbitrary resizing used to force mismatched components into place.

## Integrate coherently

1. Configure engine imports for lossless output, intended filtering, color space, compression, atlases, and animation frames.
2. Preserve native pixel geometry, integer scaling, stable pivots, declared nine-slice regions, and compatible coordinate spaces where applicable.
3. Implement all slice-relevant interaction states: default, hover or focus, pressed, disabled, selected, feedback, failure, and transition states as required by the input mode.
4. Align authored UI with deterministic layout constraints. Do not bake dynamic text, live data, focus logic, or accessibility states into static images.
5. Keep environment layers, player and NPC actors, interactive props, effects, and UI in independent runtime consumers. Never replace a working scene with a whole-screen generated plate or bake moving/stateful entities into its background.
6. Remove replaced placeholders and generic procedural chrome rather than leaving two competing systems.
7. Keep generated source, extraction, cleanup, compilation, import, and runtime capture attributable.

## Verify in the engine

1. Run the actual slice scenarios at native and shipping scale.
2. Capture complete state sequences, not isolated beauty frames.
3. Check hierarchy, clipping, anchors, hit regions, readability, silhouette, palette, perspective, z-order, state coverage, and interaction feedback.
4. Confirm every required asset is visible through its named runtime consumer and connected to real state.
5. Fail closed when a source is missing, a target hash changed, an import is lossy, or the only evidence exists outside the engine.

## Output contract

Return an `integrationReport` containing `specRevision`, `sliceId`, `targetHash`, `components`, `runtimeConsumers`, `importSettings`, `removedFallbacks`, `stateCoverage`, `provenance`, `captures`, `violations`, and `regressionChecks`.

Return `pass` only when all required components are coherent and live in the captured slice. Return `revise` with the smallest root-cause repair. Return `blocked` when target or provenance integrity is missing.
