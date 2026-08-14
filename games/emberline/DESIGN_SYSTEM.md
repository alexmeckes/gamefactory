# Emberline Design System: Living Instrument Workshop

Version 1.0.0 defines Emberline's semantic visual and sensory language. It does not prescribe a screen layout, route geometry, or asset pipeline. Later work should use these roles to make its own composition while retaining the same hierarchy and cause-and-effect grammar.

## Supported hypothesis

A living fuse can be the strategic center without becoming a dense meter layer if its condition is expressed as a small physical vocabulary: intact braid, expanded coil and raised heat tab, then split sheath and iron danger notch. Each instrument should alter that shared object through a unique silhouette and mechanical beat. This is supported by the campaign's one-route constraint, the scouts' three-state pressure proposal, and the pinned target's material response language.

Assumptions:

- The route remains the first gameplay read at 1152 x 720.
- A player can understand one local marker per fuse band while still reading enemies and health.
- Three sharply different instrument silhouettes are more useful than many decorative variations.
- The cyan heart is precious enough to reserve cyan for protection, cooling, and safe-state feedback.

Revise or simplify if local state requires a legend during combat, Bell becomes a mandatory tax at every socket, particles obscure the route, or the most important state disappears in grayscale or reduced motion.

## Identity

Emberline is a quiet, tactile miniature workshop where danger travels through a crafted object. Its tone is handmade, intimate, ingenious, gently urgent, and slightly mysterious. It is not medieval, neon-science-fictional, glossy mobile UI, or ornamental steampunk clutter.

The core hierarchy is:

1. Current fuse condition and threat direction.
2. Imminent enemy or boss interference.
3. The glass heart and its vulnerability.
4. The intervention currently available to the player.
5. Economy, wave, and secondary workshop context.

## Prioritized principles

1. **Route state before ornament.** The fuse, threats, reach, target, health, and danger remain readable in motion before material detail is added.
2. **Physical state, not hue alone.** Every thermal state changes silhouette, geometry, pattern, or attachment as well as color.
3. **One instrument, one verb.** Spark opens and recoils, Bell compresses and exhales, Striker winds up and fractures.
4. **The heart is precious.** Cyan glass is the emotional focal material; threat cues create a directional line toward it.
5. **Tactile restraint.** Prefer one legible anticipation-action-settle beat over high particle volume, large bloom, or constant shake.
6. **Semantic composition.** Tokens express roles and relative emphasis; they never freeze coordinates or demand literal recreation of a reference plate.

## Tokens

### Color

| Role | Value | Use |
| --- | --- | --- |
| `surface.void` | `#0A0A0E` | deepest negative space |
| `surface.soot` | `#121116` | board and primary panel ground |
| `surface.walnut` | `#241713` | interactive workshop faces |
| `surface.iron` | `#29282B` | clamps, enemy armor, disabled surfaces |
| `line.brass` | `#DFA349` | active rims, socket craft, available actions |
| `line.copper` | `#C65A2E` | steady fuse and Spark identity |
| `state.hot` | `#F56A32` | heat and imminent thermal danger |
| `state.danger` | `#FF5A3D` | critical consequence, always with notch/chevron |
| `state.cool` | `#73DDE8` | Bell action and cooling response |
| `heart.cyan` | `#84F4EF` | heart focal light and safety response only |
| `ceramic.bone` | `#D8CBB7` | Bell body and calm neutral highlights |
| `text.primary` | `#F4E8D2` | essential text on dark surfaces |
| `text.secondary` | `#A89991` | supporting text and inactive status |
| `focus` | `#84F4EF` | keyboard focus ring, paired with 3 px outline |

Use warm accents for action and danger, cool accents for protection and control. Never make color the only state channel. At gameplay scale, background saturation should be lower than route, threats, heart, and interactive affordances.

### Typography

- `display`: humanist sans or restrained small-cap face, 42 px nominal, 1.5 px tracking; title only.
- `heading`: sturdy sans, 24 px, semibold; major state changes and ending headings.
- `control`: sturdy sans, 17 px, semibold, short verbs; buttons and instrument names.
- `body`: clear sans, 18 px, regular; onboarding and concise explanations.
- `caption`: clear sans, 14 px, medium; prices, wave detail, secondary counters.
- `numeric`: tabular numerals, 18 px, semibold; credit, health, and wave counters.
- Essential gameplay text must not render below 14 px at the 1152 x 720 reference viewport. Use sentence case for instruction, short uppercase only for compact mechanical states.

### Spacing

The base unit is 4 px. Use `1=4`, `2=8`, `3=12`, `4=16`, `5=24`, `6=32`, `7=48`, and `8=64`. Interactive targets are at least 44 x 44 px. Adjacent major controls use at least 8 px separation. Dense counters may use 4 px internal gaps, never 4 px click separation.

### Shape

- `radius.control`: 5 px, like fitted workshop plates rather than pills.
- `radius.panel`: 6 px with 1 px iron/brass rim.
- `radius.focus`: control radius + 2 px, drawn outside the component.
- `socket`: concentric round collar with a keyed notch; selection adds a second collar.
- `danger`: downward iron chevron or sharp notch; never a soft badge alone.
- `success`: seated collar, outward ring, or aligned seam.
- `fracture`: three to five large wedges; avoid confetti-sized shards.

### Material

- `charred_walnut`: low-saturation grain, broad value variation, subdued near tactical marks.
- `soot_iron`: almost-black, rough edge highlights, heavy silhouette for clamps and Striker.
- `hammered_brass`: warm irregular rim; reserve brightest brass for active/available affordances.
- `copper_filament`: directional braid and specular thread; expands for heat and separates for fray.
- `bone_ceramic`: pale crazed surface with thick rim; Cooling Bell and cooling collars.
- `cyan_glass`: internal light, visible metal cage, localized bloom; heart first, cooling second.
- `wax_and_soot`: environmental support only; never overlap route or labels.

Material separation must survive low effects settings through base value and edge treatment, not reflections alone.

### Motion

- `anticipation.fast`: 90 ms; target notch, shutter twitch, or striker preload.
- `anticipation.readable`: 140 ms; boss clamp warning and important adaptation beats.
- `action.fast`: 60 ms; Spark discharge and snap selection.
- `action.weighted`: 100 ms; Bell compression or Striker contact.
- `settle.light`: 140 ms; socket seat and minor impact.
- `settle.weighted`: 220 ms; Striker recoil, clamp break, heart hit.
- `toast.hold`: 900-1400 ms based on importance, with no overlapping tutorial stack.
- `screen_shake`: maximum 4 px for 120 ms on boss/clamp impact only; zero under reduced motion.

Use one dominant movement per beat. Placement is hover/align -> 60 ms seat -> 140 ms brass collar settle. Spark is shutter-open -> angular flare -> coil recoil. Bell is compression -> one low mist ring -> ceramic settle. Striker is preload -> contact -> three large fracture wedges -> weighted recoil.

### Audio

- `wave_ignite`: short wax hiss into a low metal latch.
- `spark_fire`: dry coil snap; pitch family high and narrow.
- `bell_fire`: hollow ceramic tone with a cool breath tail.
- `striker_fire`: muted iron wind-up and weighted contact.
- `temper`: descending ceramic interval and steam release.
- `shatter`: one sharp crack followed by two lower fragments.
- `flashboil`: compressed hiss then tight pop; never an explosion wall.
- `leak_core`: cyan glass stress ping plus low heart thump.
- `boss_warning`: two slow clamp knocks, distinct from wave start.
- `victory` / `defeat`: resolved workshop chord / extinguished filament decay.

Route SFX through `SFX`, UI through `UI`, and music/ambience through `Music`. Provide master mute and reduce repetitive high-frequency cues when reduced intensity is enabled. Limit identical rapid cues to three voices and apply small pitch variation only where instrument identity remains stable.

### Feedback

- `available`: bright brass rim + open keyed notch + concise action verb.
- `selected`: double collar + persistent range geometry + material-specific ghost.
- `unaffordable`: muted iron face + price remains legible + no red danger treatment.
- `invalid`: closed notch + 90 ms lateral mechanical nudge; no punitive full-screen effect.
- `spend`: number ticks once, brass fleck travels inward, control seats.
- `damage`: enemy HP change + one contact mark; never floating numbers alone.
- `reaction`: named compact label/icon + physical route/enemy response + distinct instrument signature.
- `core_damage`: heart cage contracts, crack highlights, directional leak line; preserve control visibility.
- `wave_ready`: wax wick steadies and the start control becomes warm, outlined, and enabled.

### Accessibility

- State is encoded by at least two channels: hue plus silhouette, pattern, notch, collar, chevron, or text/icon.
- `STEADY`: tight intact braid + seated round collar.
- `HOT`: expanded coil + one raised rectangular heat tab.
- `FRAYED`: split sheath + branching filament + sharp iron danger notch.
- `KINDLED`: upward flame/coil tick; `BRITTLE/CHILLED`: ceramic cinch; `SHATTER`: broken ring or fracture wedge.
- Focus is a 3 px cyan outline outside the component; hover and focus must not share exactly the same treatment.
- All primary pointer targets are at least 44 x 44 px and expose a visible label or stable icon plus tooltip.
- Reduced motion replaces travel, shake, and particle bursts with a held end-state geometry for at least 180 ms; timing windows and gameplay simulation do not change.
- Reduced intensity lowers bloom, sparks, mist, shake, and repeated high-frequency audio without removing target, state, or consequence cues.
- Essential contrast target is 4.5:1 for normal text and 3:1 for large text and meaningful control boundaries.

## Reusable patterns

### Living fuse band

Render an authored band as base shadow, physical sheath, conductive braid, state attachment, and sparse local light. State attachment is one marker only: seated collar, raised tab, or danger notch. Avoid bars above every segment and glow-only state.

### Instrument identity

Spark is tall/coiled and opens; Bell is wide/hollow and compresses; Striker is squat/directional and recoils. Range arcs inherit material pattern but not exclusive hue. An instrument remains identifiable as a monochrome silhouette.

### Placement preview

Show a material-specific ghost seated above a socket, one keyed alignment cue, range geometry, and the first reachable fuse band or target. Confirm with a seated snap and collar settle. Do not show dense damage tables on the board.

### Threat-to-heart line

Use one forward iron chevron on the most imminent threat and one pulse/notch on the threatened band. Keep the heart luminous but do not brighten every enemy equally. Danger must point toward consequence.

### Reaction beat

Use anticipation -> contact -> one physical response -> settle. Pair a short reaction name/icon with the response. Prefer coil recoil, ceramic cinch/mist, and fracture wedges over generic motes.

### Furnace-warden clamp

Telegraph with two clamp knocks, a 140 ms iron jaw preload, and a marked band. On contact the jaw creates FRAYED geometry. Cooling adds a pale ceramic collar and visibly loosens the jaw; Striker adds a bold fracture seam and breaks it. Avoid hidden immunity, repeated clicking, and modal interruption.

### Workshop control plate

Use deep walnut/soot face, fitted 5 px corners, 1 px rim, 44 px minimum target, short verb, and explicit disabled/unaffordable treatment. Primary actions receive brass emphasis; keyboard focus always receives the cyan exterior outline.

### End-state feedback

Victory reseats the fuse and heart cage with a controlled cyan/amber resolution. Defeat extinguishes filament light but leaves restart fully legible. Both endings preserve a single obvious replay action.

## Reference studies

These ImageGen outputs are visual-language evidence, not running-project captures and not final screenshots. Rebuild their semantic roles with engine-native rendering; do not trace their composition.

### Material and fuse-state study

- Path: `design/references/emberline-material-fuse-study.png`
- SHA-256: `1944d50ca067bea64f2503629505e9598dc06002b3b7596f19104174f788c0e8`
- Source: built-in ImageGen
- Role: tactile materials, three physical fuse states, and instrument silhouette separation.

Exact final prompt:

```text
Use case: stylized-concept
Asset type: controlled game visual-language study — material and fuse-state reference, not a final screenshot
Input images: Image 1 is the aspirational reference for tactile workshop materials, warm/cool lighting, and miniature craftsmanship; Image 2 is a baseline readability reference showing the existing single-route board and sparse silhouettes, not a layout to copy
Primary request: create one polished concept study for EMBERLINE showing a compact section of a living braided copper fuse across a charred walnut workbench, with three clearly separated physical state specimens: STEADY, HOT, and FRAYED. Integrate three small handcrafted instrument maquettes nearby: a copper-coil Spark instrument with a shuttered aperture, a crazed bone-ceramic Cooling Bell with a deep bowl, and a soot-black iron Striker with a heavy offset hammer. The study must establish reusable material and silhouette language, not dictate a full level composition.
Scene/backdrop: dark intimate workbench specimen stage with restrained iron fixtures, hammered brass collars, wax traces, and cool blue-black shadow
Style/medium: premium tactile miniature-diorama concept art; physically believable craft; painterly-real materials; code-native Godot implementation reference
Composition/framing: landscape 16:9, oblique top-down close study; three fuse-state specimens readable as a left-to-right progression; instruments separated with generous negative space; no complete game board and no HUD
Lighting/mood: precious ember warmth against cyan ceramic/glass cooling light; gently urgent, ingenious, slightly mysterious; controlled highlights, restrained bloom
Color palette: soot-black, charred walnut, ember copper, aged brass, bone ceramic, cyan glass; cyan reserved for heart/cooling/safe response and amber-red reserved for heat/danger
Materials/textures: braided copper, split sheath fibers, raised brass heat tab, dark iron danger notch, crazed ceramic, hammered brass, oxidized copper, soot, wax, glass
State communication: STEADY uses an intact tight braid and seated collar; HOT visibly expands the coil and raises one brass heat tab in addition to warmer light; FRAYED splits the sheath silhouette, exposes branching filament, and adds a sharp iron danger notch in addition to red-orange heat. The three states must remain distinguishable in grayscale.
Instrument identity: Spark reads tall and coiled with an opening shutter; Bell reads wide and hollow with a ceramic rim; Striker reads squat, weighted, and directional with visible recoil mechanics
Constraints: visual study only; no enemies, no characters, no medieval towers, no green terrain, no neon sci-fi, no glossy vector cards, no dense ornament, no interface mockup, no tiny labels, no logos, no watermark, no final-screen composition to copy
```

### Hierarchy, component, and motion study

- Path: `design/references/emberline-hierarchy-motion-study.png`
- SHA-256: `a21ed4e015d81f8641c22407343b2e6729652c0049454caf4ca44c18abd7c17c`
- Source: built-in ImageGen
- Role: placement hierarchy, instrument beats, threat-to-heart line, and the readable boss-clamp response.

Exact final prompt:

```text
Use case: stylized-concept
Asset type: controlled game visual-language study — gameplay hierarchy, reusable components, and motion beats, not a final screenshot
Input images: Image 1 is the aspirational reference for tactile workshop materials, warm/cool lighting, and miniature craftsmanship; Image 2 is a baseline combat-readability reference whose flat circles, uniform route, and sparse feedback must be materially surpassed without copying its layout
Primary request: create one polished EMBERLINE concept study arranged as four generous cinematic keyframe vignettes on a dark workshop presentation plate. Show how one living fuse, three handcrafted instruments, small coal-and-rivet threats, a luminous cyan glass heart, and one furnace-warden clamp communicate cause and effect at gameplay scale. The study should define hierarchy and motion signatures that can be rebuilt with Godot drawing and shaders, not prescribe a complete interface or level.
Scene/backdrop: oblique top-down miniature workbench fragments, each vignette focused on a short fuse bend with sparse physical props and controlled negative space
Style/medium: premium tactile miniature-diorama concept art; physically believable craft; painterly-real materials; code-native Godot implementation reference
Composition/framing: landscape 16:9 reference plate with four clearly separated vignettes and no complete board. Vignette 1: placement preview, an empty brass socket accepting a translucent instrument silhouette while a thin mechanical reach arc points to one fuse band. Vignette 2: instrument choreography, Spark shutter opens with a tight angular flare, Cooling Bell compresses then exhales one low ceramic-cinch mist ring, Striker winds up and snaps forward with three large fracture wedges. Vignette 3: threat hierarchy, two small enemies move along a HOT fuse toward a luminous cyan glass heart; the imminent threat has a forward iron chevron and the threatened segment has one raised tab, while background props remain subdued. Vignette 4: furnace-warden adaptation, a massive soot-iron clamp bites a FRAYED fuse segment; a cyan ceramic cooling collar visibly loosens the clamp, then a bold striker fracture seam shows the next response.
Lighting/mood: precious ember warmth against cool cyan heart and cooling accents; gently urgent, intimate, ingenious; strong focal falloff; restrained bloom and particle count
Color palette: soot-black, charred walnut, ember copper, aged brass, bone ceramic, cyan glass; cyan reserved for heart/cooling/safe response and amber-red reserved for heat/danger
Component language: primary actions use warm hammered-brass rims and deep walnut faces; selection uses a double mechanical collar; danger uses iron chevrons, raised tabs, split silhouette, and notches; cooling uses ceramic cinches and condensed rings; success uses a brief seated snap and clean outward ring
Motion language: anticipation 90–140 ms, action 60–100 ms, settle 140–220 ms; one dominant movement per beat; readable recoil and silhouette change; reduced-motion equivalents shown as held end-state geometry rather than particles
Accessibility: every important state must remain distinguishable in grayscale through silhouette, pattern, notch, collar, chevron, or fracture geometry; heart, threat, and available response form the brightest three-step hierarchy
Constraints: visual study only; no readable prose labels, no final HUD, no full game-screen composition, no floating magic runes, no generic medieval towers, no green terrain, no neon sci-fi, no glossy mobile cards, no particle fog, no tiny decoration, no logos, no watermark
```

## Godot implementation

`design/theme/emberline_theme.tres` is the native adapter for common Control nodes. It supplies the dark walnut/soot ground, brass active controls, cyan focus, text hierarchy, fitted corners, progress treatment, and tooltips. Gameplay drawing remains responsible for route materials, fuse-state geometry, instruments, enemies, motion, and reactions; it should consume the same semantic roles rather than approximate the reference images as backgrounds.

The accepted system must stay extensible. New states or components should define an intent, a semantic token role, a non-hue channel, a reduced-motion form, and an audio/feedback consequence before they add visual ornament.
