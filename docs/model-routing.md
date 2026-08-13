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

## Advisor escalation

A graph node can declare a bounded advisor route when its efficient primary
model may encounter a real capability gap:

```json
{
  "model": "gpt-5.6-luna",
  "reasoningEffort": "high",
  "advisor": {
    "model": "gpt-5.6-sol",
    "reasoningEffort": "high",
    "outcomes": ["needs_advisor"],
    "onFailure": true,
    "maximumAttempts": 1
  }
}
```

The primary agent is told that escalation exists and may return
`needs_advisor` with partial findings, evidence, assumptions, and the remaining
gap. A configured hard invocation failure can also trigger the handoff. The
advisor receives the complete primary handoff and runs as a separate,
attributable invocation. It does not silently replace or relabel the Luna run.

Advisor attempts count against `maximumTotalAttempts`. If the advisor fails or
returns an escalation outcome through its bounded attempts, the required graph
node fails closed. The trace records an advisor edge, both model identities,
both usage records, and every preserved artifact.

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
  distinct search behavior is valuable, with a sparse Sol advisor route for
  material capability gaps rather than making Sol the default;
- use Sol/medium for routine, deterministic verification;
- use Sol/high for technical synthesis and implementation;
- use Sol/xhigh for sparse, consequential design selection and final
  experience/art-direction judgment.

Knot Theory applies that policy per node. Re-run
`npm run benchmark:model-routing` as the task set grows. Prefer a Pareto view of
quality, latency, and tokens; do not collapse the result into a permanent global
default from this small sample.
