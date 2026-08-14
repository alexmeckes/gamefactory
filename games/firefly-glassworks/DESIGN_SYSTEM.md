# Firefly Glassworks — Layered Illustrated Workshop

Maturity: `production-slice`

## Bounded hypothesis

A small set of painterly, topology-neutral bitmap layers can give the fixed 1152×720 board the specificity of an intimate glassworker’s bench. Godot-native geometry remains authoritative for mirror orientation, focus, sensor contact, shutter state, receiver arrival, hit testing, and beam travel. The method is supported only for the representative finale and the required first-puzzle reuse proof; the remaining levels, title, ending, audio, and asset variants are deliberately unfinished.

## Principles

1. **One living light is always first.** The amber path uses a dark separation stroke, narrow hot core, visible leading point, and contact facets. Arrival changes the receiver instead of recoloring the whole route.
2. **State is geometry before color.** A cold sensor is hollow and a contacted sensor is filled; a closed shutter is continuous and an open shutter is two separated halves; a cold receiver is hollow and an arrived receiver is filled and value-bright.
3. **Material texture stays subordinate.** Broad soot, wood wear, brass patina, and glass striation add specificity without crossing the semantic overlay layer.
4. **Every moving layer has one exact pivot.** The mirror atlas region and native orientation spine share the cell center. The full cell remains the input target regardless of alpha.
5. **Prove one interaction before expansion.** The finale is the finished slice. FIRST REFLECTION demonstrates reuse without repainting; it is not permission to finish the whole game.

## Semantic tokens

### Color

| Token | Value | Use |
| --- | --- | --- |
| `surface.workbench` | `#0b0d0f` | Deep neutral beneath texture |
| `surface.board` | `#080b0d` at 67% | Quiet inset board field |
| `ink.primary` | `#eee8da` | Titles, focus, high-value state edges |
| `ink.muted` | `#aaa394` | Lessons and utility copy |
| `material.brass` | `#a7773f` | Rails, mounts, inactive linkage |
| `material.brassHighlight` | `#d1a05c` | Edges, pivots, active linkage |
| `light.firefly` | `#ffb94f` | Beam body and source |
| `light.fireflyHot` | `#fff1b0` | Beam core, contact facets, focus ticks |
| `light.receiver` | `#80d7d1` | Cold/arrived receiver structure |
| `light.receiverHot` | `#d4fffa` | Arrived aperture only |
| `material.glassEdge` | `#9bbfc8` | Native reflector spine |
| `state.danger` | `#e07065` | Loop exception only |

### Typography

The implementation uses Godot’s bundled fallback sans font so capture and runtime use the same available resource without a host-font dependency. This production slice treats it as an explicit compatibility choice, not a final branded type asset.

| Token | Value |
| --- | --- |
| `type.family` | `ThemeDB.fallback_font` |
| `type.brand` | 14 px, amber, uppercase |
| `type.puzzleTitle` | 31 px, warm off-white |
| `type.lesson` | 16 px, muted warm gray |
| `type.utility` | 13–17 px, uppercase |
| `type.titleScreen` | 66 px maximum; compatibility surface only |

### Spacing

| Token | Value |
| --- | --- |
| `space.cell` | 88 px |
| `space.boardOrigin` | 188 × 126 px |
| `space.boardSize` | 704 × 440 px |
| `space.boardFrame` | 10–13 px |
| `space.instrumentArt` | 72–86 px destinations centered in one cell |
| `space.focusRadius` | 39 px |
| `space.resetControl` | 158 × 54 px |

### Material

- `bench`: topology-neutral ImageGen raster with low-frequency smoke-charcoal wear; runtime-darkened.
- `brass`: painterly atlas patina plus native edge and rail geometry.
- `glass`: irregular smoke-blue atlas insert plus a crisp native value spine.
- `shadow`: shallow local contact shadows only; no global bloom or fog.
- `beam`: native geometry only; no light path exists in a bitmap.

### Motion

| Token | Value | Contract |
| --- | --- | --- |
| `motion.mirrorQuarterTurn` | 0.18 s | Visual tween around the authoritative cell center; gameplay orientation changes immediately |
| `motion.completionDelay` | 0.55 s | Existing progression pause |
| `motion.beamReveal` | 0.42 s | Every normal level load and mirror action restarts the nonblocking visual travel; topology and simulated state update immediately |
| `motion.receiverSettle` | 0.12 s | Begins only after the revealed beam reaches the receiver and completes within the existing progression pause |
| `motion.captureSamples` | `[0.075, 0.151, 0.231, 0.280, 0.080, 0.260, 0.300]` s | Seven deterministic elapsed-time samples use the same presentation update as live play; no reveal fraction or state is injected |
| `motion.leadingMote` | 7 Hz restrained pulse | Direction aid; never changes topology |
| `motion.reset` | immediate state restore | No blocking presentation delay |

### Accessibility

- Important states use fill, aperture, continuity, separation, and value—not hue alone.
- Focus uses a high-value ring plus cardinal ticks and survives desaturation.
- The beam has a dark 13 px separation stroke, 9 px aura, 3.5 px amber core, and 1.1 px hot center.
- Full 88 × 88 cells remain clickable even where painterly alpha is transparent.
- Reset is always visible, keyboard-accessible with `R`, and restores state immediately.
- The control surface names arrow/Tab focus traversal as well as click/Space turning.
- Texture is intentionally low contrast beneath the board and cannot occlude beam contacts.

## Reusable patterns

### Layered instrument assembly

Render shallow native contact shadow → painterly brass mount → centered painterly insert → native orientation/focus/state geometry → living beam. Never use sprite alpha as hit geometry.

### Persistent transformation

Cold sensor: hollow dark aperture. Contacted sensor: bright filled aperture with a square contour. Closed shutter: one continuous blocking member. Open shutter: two retracted halves and a persistent empty center. Authoritative latch state updates immediately, while these visible contact/open forms switch only when the live reveal reaches the sensor. Labels are not required to distinguish the states.

### Living beam

Keep the whole path amber. Draw a dark separation stroke, restrained aura, core, hot center, contact facets, and a leading mote. Restart its 0.42-second reveal from normal recompute timing. Arrival is expressed in the receiver’s aperture and 0.12-second value settle only after the leading beam reaches it.

### Minimal bench control

Keep puzzle title, one-sentence lesson, turn legend, arrow/Tab focus hint, focus feedback, level position, and reset. Do not restore the observations dashboard, rotation counter, or redundant textual state readout.

## Evidence and provenance

- Running production target: `design/references/firefly-production-slice.png`, captured by Godot at the shipping viewport.
- Complete running sequence: `design/captures/motion-000.png` through `motion-006.png`.
- Exact ImageGen prompts and byte hashes: `assets/illustrated/provenance.json`.
- Engine/resource/camera manifest: `design/production-slice.json`.

Only the running capture is a production target. Generated raster sources are material inspiration and implementation resources, never substitutes for the engine capture. The deterministic scenario proves stability and the accepted solution language; it is not human evidence of fun.

## Explicit omissions

No bespoke finish for the middle two puzzles, production title or ending art, extra asset variants, workshop clutter, particles, fog, bloom, audio, camera change, 3D conversion, topology-specific backgrounds, or baked semantic state. Expansion is a later production decision only if this vocabulary is accepted.
