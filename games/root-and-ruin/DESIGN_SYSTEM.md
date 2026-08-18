# Root & Ruin visual system

Status: vertical-slice lock. This system may evolve after playtesting, but a candidate must not silently replace it.

## Play-first hierarchy

1. The 3-lane board, plants, enemies, and shared root network dominate the screen.
2. Cyan always means hydration; magenta always means corruption; orange-red means an imminent strike.
3. The current selection and legal action are visible without reading prose.
4. The right rail explains the selected plant, its orientation, and the next strike. It never competes with the board.

## Pixel contract

- Runtime viewport: 1152 × 720, integer coordinates, nearest-neighbor texture filtering.
- Compact front three-quarter sprites with hard silhouettes and one shared light direction.
- No painterly backgrounds, cinematic perspective, smooth vector mascots, glass cards, default gray buttons, or decorative detail that obscures the root graph.
- Engine-rendered text only. Generated images never supply final labels or numbers.

## Palette

| Role | Hex |
| --- | --- |
| ink | `#090d0d` |
| soil | `#111a17` |
| raised soil | `#1a2821` |
| wood frame | `#382f26` |
| frame highlight | `#75654d` |
| bone text | `#e8dcc0` |
| moss | `#78935b` |
| hydration | `#34d5df` |
| blight | `#e13b91` |
| action amber | `#e4ae4e` |

## Asset provenance

- `design/ui-target-v1.png`: ImageGen gameplay-screen target. It is reference, not a runtime screenshot.
- `design/sprite-atlas-source.png`: ImageGen source atlas.
- `assets/generated/**`: transparent instance cutouts extracted from that atlas by the local SAM3 extension.
- Layout, state, labels, meters, root simulation, interaction, and effects are authored in Godot.

## Approval gates

- Mechanics may use primitives during the first contract test.
- One representative screen must then pass a visual-target review before asset production expands.
- Full asset generation begins only after the interaction is playable and the representative screen proves the style in engine.
- Captures used for review must come from Godot and identify their scenario and revision.
