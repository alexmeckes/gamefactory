# ImageGen provenance

Tool: OpenAI ImageGen via the built-in Codex image generation tool.

## UI target

Prompt summary: a shippable 1152 × 720 gameplay screen for a fantasy pixel-art autobattler, with a 3 × 2 root garden, three plant units, three blight enemies, a Springheart, cyan hydration and magenta corruption on the same root graph, and an authored right-hand planning rail. Explicitly excluded concept art, isometric dioramas, painterly rendering, generated microtext, and splash-screen composition.

Output: `ui-target-v1.png`

## Sprite source atlas

Prompt summary: an eight-cell pixel-art production atlas containing Bastion Cap, Dewbell, Briar Spitter, Springheart, three blightling archetypes, and water/blight UI symbols, with consistent gameplay view, scale, palette, and lighting.

Output: `sprite-atlas-source.png`

The source atlas background was not trusted as transparency. SAM3 is used to extract individual subjects; Godot remains responsible for composition and UI.
