# Model routing

`agent.team` supports defaults at `parameters.agentTeam` and overrides on every
legacy contributor or graph node:

```json
{
  "adapter": "codex-app-server",
  "model": "gpt-5.6-luna",
  "reasoningEffort": "high"
}
```

Supported effort values are `none`, `low`, `medium`, `high`, `xhigh`, and
`max`. The Codex App Server adapter maps `reasoningEffort` to the protocol's
turn-level `effort` field. Traces and prompt manifests retain both the requested
model/effort and the provider-resolved model/effort. A routing benchmark only
counts a run as successful when both values match.

## Initial routing tournament

The 2026-08-13 tournament ran two read-only, deterministic repository-audit
tasks once through each profile. Quality is a 100-point evidence-and-concept
rubric. Tokens are observed subscription token consumption, not dollar cost.

| Profile | Mean quality | Mean latency | Total tokens | Reasoning tokens |
| --- | ---: | ---: | ---: | ---: |
| Luna / high | 92.5 | 74.9 s | 140,284 | 4,557 |
| Sol / medium | 85.0 | 36.1 s | 119,284 | 997 |
| Sol / high | 92.5 | 41.8 s | 119,231 | 1,040 |
| Sol / xhigh | 100.0 | 49.2 s | 121,192 | 2,277 |

This is a routing smoke benchmark, not a universal model ranking. With only two
tasks, its useful conclusions are directional:

- use Luna/high for divergent, high-volume creative exploration where its
  distinct search behavior is valuable, not as the default for repository
  analysis;
- use Sol/medium for routine, deterministic verification;
- use Sol/high for technical synthesis and implementation;
- use Sol/xhigh for sparse, consequential design selection and final
  experience/art-direction judgment.

Knot Theory applies that policy per node. Re-run
`npm run benchmark:model-routing` as the task set grows. Prefer a Pareto view of
quality, latency, and tokens; do not collapse the result into a permanent global
default from this small sample.
