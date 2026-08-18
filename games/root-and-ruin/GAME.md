# Root & Ruin

Root & Ruin is a compact fantasy autobattler about cultivating a formation of battle-plants against an advancing blight.

## Product hypothesis

Players can understand that the same root network carries both useful water and dangerous corruption, then make one meaningful formation change that visibly improves the next automated battle.

The game is not a generic shop-and-traits autobattler. Its primary instrument is the living root network.

## Vertical-slice boundary

- One 3x2 garden formation with a fixed spring source.
- Three plant combatants with distinct silhouettes and combat rhythms.
- Root ports connect only when adjacent plants reciprocate.
- Hydrated plants act much more effectively.
- A telegraphed blight strike infects one lane and can spread through connected roots.
- Three short battles, with a planning phase between them.
- Rotation is the only required planning manipulation in the first slice.
- Deterministic scenarios compare a fully connected formation with a deliberately isolated branch.

The graybox should remain procedural and visually plain. It may use semantic color, motion, and labels required to explain state, but it must not manufacture polish as evidence that the loop works.

## Success evidence

- A connected network visibly distributes water.
- A blight strike and every subsequent spread step have attributable source and destination.
- At least one authored encounter rewards isolating a threatened branch while keeping the rest hydrated.
- Battle outcome and recap identify why the formation succeeded or failed.
- Reset restores the exact authored state.
- A real Godot scenario records outcomes for connected and containment formations.

These contracts establish behavior and readability evidence. They do not establish human fun.

## Open design space

Agents may explore plant roles, root shapes, enemy cadence, encounter order, drafting, rewards, heat-like resource pressure, and whether later units move during combat. They must preserve the root-network hypothesis and keep causal feedback inspectable.

Production assets begin only after the gameplay slice passes. The first approved unit then moves through a pinned pixel design system, ImageGen reference art, Omni image-to-video motion, SAM3 tracking, pixel-motion compilation, and a real Godot capture.
