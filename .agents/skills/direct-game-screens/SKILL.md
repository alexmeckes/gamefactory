---
name: direct-game-screens
description: Design and review coherent whole-screen gameplay targets before producing individual UI or art assets. Use after gameplay proof when defining visual direction, screen-state variants, layout regions, typography, motion, or component decomposition. Do not use to decorate an unproven graybox or generate isolated assets first.
---

# Direct Game Screens

Start from proven gameplay states at the shipping camera and native aspect ratio. Treat ImageGen outputs as proposed targets, not production game screens.

## Establish the screen problem

1. Inventory the minimum states needed to communicate interaction, action, feedback, recovery, and transition.
2. For each state identify the player’s current question, primary action, essential information, actors, and persistent context.
3. Define peer layout regions for playfield, controls, status, narrative, and overlays. State which overlaps are intentional.
4. Choose pixel, hybrid, or non-pixel typography by information role. Reserve pixel display type for short identity accents when dense reading needs a calmer face.

## Generate complete directions

1. Produce at least two complete screen directions that solve the same gameplay state and preserve the same art direction.
2. Generate required state variants as whole scenes, not disconnected mood boards.
3. Review every viewport for hierarchy, scale, legibility, control plausibility, actor-to-UI balance, state comprehension, and engine feasibility.
4. Reject concept art, contradictory controls, decorative frames that consume interaction space, accidental overlaps, illegible copy, and compositions that work in only one state.
5. Select one direction and state why it wins. Do not average incompatible directions together.

## Define controlled life

Specify meaningful ambient continuity, interaction response, gameplay consequence, and transition motion. Avoid frozen tableaux, unrelated looping noise, and animation quotas.

## Decompose after approval

For the selected target define exact component bounds, native sizes, states, layering, anchors, typography roles, animation needs, source prompts, and target hashes. Write or update `gamefactory.scene-target/v1` when writes are permitted.

Return `pass` only when a complete direction and required variants are coherent and decomposable. Return `revise` with prioritized scene-level changes before requesting individual assets.
