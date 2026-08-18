---
name: produce-pixel-game-assets
description: Derive coherent production pixel-art sprites, portraits, UI surfaces, effects, and animations from an approved whole-screen target. Use during pixel-art production, ImageGen decomposition, SAM3 extraction, Omni-assisted animation, or pixel-motion compilation. Do not use before a target direction and component map are approved, or as a substitute for runtime integration.
---

# Produce Pixel Game Assets

Treat the approved target hash, component map, and style profile as the source of truth. Preserve gameplay readability over literal imitation of generated pixels.

## Lock the production grammar

1. Confirm native resolution, integer scale, palette policy, contrast roles, outline language, lighting direction, material treatment, and silhouette scale.
2. Create an asset inventory with exact component IDs, bounds, states, pivots, layers, and animation responsibilities.
3. Identify elements that should remain code-native because they require dynamic text, data, focus states, or accessibility. Code-native must still be deliberately styled.

## Produce from the screen system

1. Generate or extract components from the approved whole scene rather than inventing each independently.
2. Reuse exact prompts, references, palette constraints, and view geometry across related assets.
3. Use ImageGen for source imagery; use SAM3 for segmentation or persistent object extraction when it improves edges or consistency.
4. Use video generation and SAM3 tracking only when an animation brief needs temporal source material. Compile through pixel-motion and verify loop seams, palette stability, framing, and identity.
5. Correct or regenerate assets that lose silhouette, scale, perspective, palette, or material consistency. Do not hide mismatches with procedural rectangles or excessive effects.

## Prepare runtime handoff

Export lossless formats with declared native sizes, pivots, frame timing, nine-slice regions, interaction states, source hashes, and target component IDs. Preserve provenance from target through source, extraction, cleanup, and compilation. Hand the production inventory to `integrate-game-assets`; do not claim runtime completion from source assets alone.

Return `pass` only when required source components are production-class, target-linked, coherent, and ready for runtime integration. Report blockers rather than silently substituting placeholders.
