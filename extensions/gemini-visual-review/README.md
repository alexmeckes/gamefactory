# Gemini visual review

`agent:gemini.visual-embodied` and `agent:gemini.visual-production` are bounded graph critics. They review preserved Godot evidence after objective scenario proof and can route findings back to the responsible writer before a judge runs. `evaluator:gemini.visual` exposes the same contract to evaluator waterfalls when a standalone final gate is useful. None replaces engine verification.

```json
{
  "geminiVisualReview": {
    "checkpoint": "production",
    "model": "gemini-3.7-flash",
    "credentialName": "google.gemini",
    "minimumImages": 5,
    "maximumImages": 8,
    "maximumTotalBytes": 16000000,
    "minimumScore": 76,
    "failureSeverities": ["blocker", "major"],
    "requireEmbodiedTrace": true,
    "contractPaths": ["game-spec.json", "design/scene-targets/scene-target.json"]
  }
}
```

Runtime images and videos come from prior Godot evaluator artifacts plus configured `godot.visualReview` paths. `evidencePaths` can add a small number of candidate-relative PNG, JPEG, WebP, or MP4 files. Contract JSON may identify an approved scene target; its selected primary image is hash-checked and supplied as a reference automatically.

When both graph checkpoints live in one campaign, optional `embodiedContractPaths` and `productionContractPaths` override `contractPaths` for their respective driver. Embodied review intentionally ignores production-only `godot.visualReview` paths that do not exist yet.

The provider response must satisfy a fixed JSON schema, cite supplied evidence IDs for every finding, and assign ownership to `implementation`, `target`, or `spec`. This keeps an infeasible approved target or falsified product claim from being disguised as endless implementation repair. The graph driver preserves the reviewed evidence inventory and scorecard so the deterministic Godot visual evaluator can validate the same current captures without adding a duplicate semantic art-director node. Missing credentials, missing trusted evidence, invalid media, provider errors, malformed output, unknown evidence citations, and review caps fail closed. The API key is resolved through `google.gemini` or `GEMINI_API_KEY` and is never persisted in the candidate, request manifest, report, or trace.
