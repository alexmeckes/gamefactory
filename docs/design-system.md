# Candidate-authored design systems

GameFactory separates creative direction from its implementation. A project's
immutable `STYLE.md`, visual-quality contract, and curated references describe
the north star. That direction starts deliberately lightweight. A candidate
first proves its core loop in a graybox, then turns only one representative
interaction into a reusable, engine-native production slice before expanding
the visual language across the game.

The director is an ordinary agent-graph node. It can use Codex's built-in
ImageGen through the installed `imagegen` skill, without an API key, to create a
small number of controlled visual studies. Generated images are reference
evidence rather than screenshots for downstream agents to copy. Project-bound
studies must be copied into the candidate, declared as artifacts, and recorded
with their exact final prompts and SHA-256 hashes.

## Contract

`@gamefactory/design-sdk` owns the engine-neutral
`gamefactory.design-system/v1` contract. It records:

- identity and tone;
- an explicit maturity level: `direction`, `production-slice`, or `production`;
- prioritized principles;
- arbitrary named semantic token groups;
- reusable interaction and presentation patterns;
- content-addressed references, their origin, purpose, and authority;
- content-addressed engine or tool adapters.

Token groups are intentionally open-ended. A campaign may require groups such
as color, typography, material, motion, audio, or accessibility, but the core
contract does not prescribe a screen layout, genre, engine, or rendering
technique.

An ImageGen reference has `source: "imagegen"` and must include the exact prompt.
Every reference also declares a purpose such as `material`, `gameplay`, or
`motion`, plus an authority such as `inspiration` or `production-target`.
Production targets must be captures from the running implementation and must
demonstrate gameplay, interaction, or motion. Concept art therefore cannot be
silently promoted into engine evidence.

## Staged production

Use the maturity levels as evidence claims, not schedule labels:

- `direction` may contain tokens, studies, and a lightweight engine theme. It
  should be cheap enough to discard if the gameplay hypothesis fails.
- `production-slice` means a representative interaction has been built and
  captured at the shipping camera. Its reusable resources and explicit
  omissions are recorded in an engine-specific slice manifest.
- `production` means that proven vocabulary has been expanded across the
  required game surfaces. It does not imply that every conceivable asset was
  authored.

A recommended graph is `graybox builder -> clean-start experience gate ->
mechanical correctness gate -> visual direction -> art-slice builder -> engine
capture -> art-slice gate -> presentation expansion`. The clean-start gate asks
what a new player decides, what information supports that decision, how the
result attributes cause, and why another action is desirable. Interaction
counts and deterministic reachability cannot satisfy it by themselves. Building the
whole asset family before the gameplay gate is an anti-pattern; polishing the
whole graybox without an art-slice gate is the opposite anti-pattern.

## Scene-first visual production

After gameplay proof and before individual asset generation, create several
complete gameplay-screen targets at the shipping camera. The complete screen
is the first visual source of truth because it establishes hierarchy,
composition, relative scale, text zones, character-to-interface balance, and
the relationships between surfaces. A dedicated `scene-target-gate` reviews
the whole screen for gameplay clarity, interaction and state comprehension,
internal scale, engine feasibility, and whether it can be decomposed into a
reusable runtime system. A beautiful but nonsensical concept image fails.

The approved scene-target manifest is the engine-neutral
`gamefactory.scene-target/v1` contract owned by `@gamefactory/design-sdk`. It
records:

- every candidate image, prompt, and content hash;
- one selected target id and immutable hash;
- required whole-scene state variants such as selection, action, and result;
- native viewport, grid, typography, spacing, and scaling rules;
- an experience contract covering peer composition regions, intentional
  overlap, typography roles, and planned motion beats;
- a component map identifying each source view, crop, expected state, and
  runtime dimensions.

Composition regions describe peer ownership at the complete-screen level.
Regions that intersect in the same state must mutually declare that overlap,
which makes overlays intentional while rejecting accidental collisions. The
contract does not ban layering or prescribe a layout.

Typography declares one of `pixel`, `hybrid`, or `non-pixel` plus semantic
roles and treatment rules. Pixel art is not treated as evidence that every
body label, rule, and number should use a pixel face. A project may choose any
mode, but it must explain how sustained information remains readable.

Motion is planned before asset production as semantic beats: `ambient`,
`interaction`, `gameplay`, and `transition`. Campaigns may require any subset.
The categories are not animation quotas; they ensure the selected scene has a
coherent account of life, response, consequence, and state change before a
provider lane spends time generating clips.

The contract deliberately does not choose an image model, segmentation tool,
engine, or production technique. Components may be extracted, regenerated,
code-native, or hybrid. The SDK does enforce approval identity, native
geometry, selected-state references, immutable hashes, and source-to-runtime
match evidence so adapters can innovate without losing the chain of custody.

Only after that gate passes may the asset-lane planner choose a production
method and the production writer create individual components. The polished
preset can branch explicitly into direct construction, SAM 3 segmentation, an
Omni motion study, or Omni -> SAM 3 tracking -> pixel-motion compilation. A
branch is selected only when it materially helps the approved target; unused
providers are represented as skipped graph nodes rather than silently called.
Prefer direct extraction or segmentation from the approved screen when
resolution permits. When a component must be regenerated, provide the complete
approved scene and its local crop as high-fidelity references, retain the
target hash in provenance, and composite the result back into the target
region. This preserves global context while allowing a higher-resolution,
engine-ready asset.

The later `component-fidelity` gate compares each component and the assembled
engine capture back to the approved target and state variants. It checks
lineage, silhouette, material, palette, border and ornament density,
typography relationships, native/render dimensions, and interaction hierarchy.
It rejects mixed target lineage, unconditioned generations, attractive local
assets that weaken the complete scene, and approximate matches that change
what the player notices or understands.

`gamefactory.visual-direction/v1` applies the same reference vocabulary to the
immutable project direction. It also requires a rendering strategy and a
feasibility statement. A legacy concept image with missing prompt provenance
may remain `source: "other"`, `authority: "inspiration"`, with a provenance
note; it can never satisfy a captured production-target requirement.
Implementations identify their adapter explicitly; for example, Knot Theory
uses `adapter: "godot-theme"` for a native Godot `Theme` resource.

## Evaluation and handoff

The optional `design-lab` extension contributes `evaluator:design.system`. The
evaluator validates the schema, campaign-required token groups and adapters,
candidate-root containment, and every referenced file hash. When configured
with `sceneTargetPath`, it also verifies the approved complete scene, every
state view, component source, runtime asset, and comparison artifact. It
preserves the contract, studies, and implementations as experiment evidence.
Missing, tampered, mismatched, or out-of-candidate evidence fails the candidate
before expensive engine evaluation.

Downstream visual directors and builders receive the authored files through the
normal graph dependency and candidate workspace. They should interpret tokens
as semantic roles, not hard-coded coordinates. This keeps the overall style
coherent while leaving room to explore composition, assets, animation, and
implementation details.

Repair edges are scheduling barriers. When a gameplay, scene-target,
component-fidelity, art-direction, or final-production critic returns
`revise`, the graph repairs and re-reviews that writer before scheduling any
dependent node. A downstream builder therefore cannot consume a rejected
graybox, stale target, or pre-repair capture.

Each candidate authors its own system. When a targeted tournament is justified, the winning system, its
engine adapter, and the game changes are accepted atomically; losing systems
remain reviewable in preserved evidence. This makes visual direction a tested
design decision instead of a global prompt that silently changes between
agents.

## Campaign example

```json
{
  "requires": ["evaluator:design.system"],
  "parameters": {
    "designSystem": {
      "path": "design-system.json",
      "visualDirectionPath": "visual-direction.json",
      "sceneTargetPath": "design/scene-targets/scene-target.json",
      "minimumMaturity": "production-slice",
      "requiredTokenGroups": ["color", "typography", "material", "motion"],
      "requiredAdapters": ["godot-theme", "godot-production-slice"],
      "requiredReferenceAuthorities": ["production-target"],
      "minimumReferences": 2,
      "requireImagegenReference": true,
      "requireSceneTarget": true,
      "requireSceneTargetComponentLineage": true,
      "requireSceneTargetExperienceContract": true,
      "requiredSceneTargetMotionKinds": [
        "ambient",
        "interaction",
        "gameplay",
        "transition"
      ]
    }
  }
}
```

The evaluator is a reproducibility and completeness gate, not an aesthetic
judge. Observable visual quality still belongs to engine-native capture and a
separate visual critic/evaluator.

## Production-readiness manifest

A candidate claiming `production-slice` or `production` must also pin an
implementation with `adapter: "production-readiness"`. Its file uses
`gamefactory.polish-readiness/v1` and records the representative engine build,
required surfaces, runtime asset maturity, named quality gates, and unresolved
work.

Asset maturity is deliberately explicit: `reference`, `source`, `extracted`,
`engine-ready`, and `production`. Loading an ImageGen image or SAM3 cutout in
the engine does not promote it. When `requireNoPlaceholders` is enabled, every
runtime asset and required surface must be `production`; any blocker fails the
candidate. Every evidence path in the manifest must already be content-pinned
by the design system, and representative captures must be captured
`production-target` references.

Interface chrome is a first-class required surface. A production slice records
its UI production method and inventories the reusable panels, controls, slots,
meters, icons, typography, feedback, and resolved-state components used by the
representative interaction. Raster and pixel-art directions should normally
define their exact native geometry before generating art: viewport, base
spacing unit, border weights, insets, type sizes, component footprints, and
permitted scaling. ImageGen is best used for motifs, icons, textures, and
exact-fit source within that deterministic structure. Runtime raster motifs
are compiled to their final dimensions and placed 1:1; scalable components use
declared nine-slice regions that preserve corner density. Independently
downscaling generated panels until they fit is a production failure, even when
every file is palette-locked. Deliberately designed engine-native or
code-native UI remains valid; default widgets and generic programmer
rectangles do not. The
`interface-system` polish gate evaluates the integrated result rather than
rewarding the mere presence of generated files.

`layout-integrity` reviews the full shipping viewport across required states,
not just isolated crops. It rejects undeclared collisions, clipped text,
competing interaction layers, and decorative framing that obscures gameplay.
`typography-system` reviews hierarchy and reading comfort by information role;
it does not reward pixel typography simply for matching pixel-rendered world
art.

Motion is evaluated with the same discipline. A production slice defines a
bounded motion grammar—typically anticipation, action, travel, impact,
reaction, defeat, and resolution—and connects those beats to actual gameplay
state. The `motion-choreography` gate requires a short recording from the
running engine. A still capture, sprite sheet, idle bob, or externally rendered
promo cannot establish that the interaction is animated coherently.

The complementary `scene-life` gate asks whether the representative scene
feels inhabited between decisive events. Appropriate ambient continuity,
interaction response, gameplay consequence, and state transitions should work
together without constant motion or unrelated particle noise.

The recommended polished graph is implemented by the `godot-polished` preset:
mechanical scout -> graybox writer -> clean-start experience repair gate ->
mechanical correctness gate -> visual director -> whole-scene target and
experience-contract gate -> production-slice writer -> fresh evidence audit ->
art-direction repair gate -> production judge. The evidence and review nodes rerun after repairs so a
candidate cannot pass using a stale screenshot. Luna/high handles bounded
scouting and technical audits with a Sol advisor; Sol/medium-to-xhigh owns
implementation and final visual judgment.
