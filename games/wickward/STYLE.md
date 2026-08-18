# Wickward visual system

- Native canvas: 480×270; integer 3× presentation.
- Runtime sprites: 64×64, nearest-neighbor, shared 16-color palette.
- Palette roles: ink/deep/slate for structure, parchment for text, gold for focus, red/blue/violet for combat grammar, green for recovery.
- Shapes: one-pixel borders, square particles, stepped diagonals, no smooth gradients.
- Hierarchy: title and encounter state; battlefield; formation role labels; one primary action.
- Motion: whole-pixel bob, short point-to-point projectiles, two-pixel particles, integer-aligned damage text.
- Source sheets and conceptual targets are never runtime surfaces.
