# Candidate-authored design systems

GameFactory separates creative direction from its implementation. A project's
immutable `STYLE.md`, visual-quality contract, and curated references describe
the north star. A candidate's Design System Director turns that direction into
a concrete, reusable visual language before gameplay polish begins.

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
- prioritized principles;
- arbitrary named semantic token groups;
- reusable interaction and presentation patterns;
- content-addressed references and their origin;
- content-addressed engine or tool adapters.

Token groups are intentionally open-ended. A campaign may require groups such
as color, typography, material, motion, audio, or accessibility, but the core
contract does not prescribe a screen layout, genre, engine, or rendering
technique.

An ImageGen reference has `source: "imagegen"` and must include the exact prompt.
Implementations identify their adapter explicitly; for example, Knot Theory
uses `adapter: "godot-theme"` for a native Godot `Theme` resource.

## Evaluation and handoff

The optional `design-lab` extension contributes `evaluator:design.system`. The
evaluator validates the schema, campaign-required token groups and adapters,
candidate-root containment, and every referenced file hash. It preserves the
contract, studies, and implementations as experiment evidence. Missing,
tampered, or out-of-candidate evidence fails the candidate before expensive
engine evaluation.

Downstream visual directors and builders receive the authored files through the
normal graph dependency and candidate workspace. They should interpret tokens
as semantic roles, not hard-coded coordinates. This keeps the overall style
coherent while leaving room to explore composition, assets, animation, and
implementation details.

Each tournament candidate authors its own system. The winning system, its
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
      "requiredTokenGroups": ["color", "typography", "material", "motion"],
      "requiredAdapters": ["godot-theme"],
      "minimumReferences": 2,
      "requireImagegenReference": true
    }
  }
}
```

The evaluator is a reproducibility and completeness gate, not an aesthetic
judge. Observable visual quality still belongs to engine-native capture and a
separate visual critic/evaluator.
