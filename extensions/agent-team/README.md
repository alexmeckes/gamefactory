# Agent team extension

`agent.team` can run either the original bounded team pipeline or a declarative task graph inside one candidate. The graph is optional: existing `scouts -> planner -> implementer -> critics` campaigns continue to work unchanged.

## Legacy pipeline

The legacy configuration runs read-only scouts in parallel, one read-only planner, one writer, and read-only critics in parallel:

```json
{
  "parameters": {
    "agent": "agent.team",
    "agentTeam": {
      "maximumParallel": 4,
      "maxOutputCharacters": 20000,
      "provider": "openai",
      "model": "your-model-id",
      "billingMode": "subscription",
      "scouts": [
        { "id": "systems", "command": ["pi", "--mode", "scout"] },
        { "id": "gameplay", "command": ["pi", "--mode", "scout"] }
      ],
      "planner": { "id": "lead", "command": ["pi", "--mode", "plan"] },
      "implementer": { "id": "builder", "command": ["pi", "--mode", "write"] },
      "critics": [
        { "id": "safety", "command": ["pi", "--mode", "review"] },
        { "id": "quality", "command": ["pi", "--mode", "review"] }
      ]
    }
  }
}
```

## Declarative graph

Use `agentTeam.graph` when the director needs a task-specific team instead of the fixed pipeline:

```json
{
  "parameters": {
    "agent": "agent.team",
    "agentTeam": {
      "maximumParallel": 4,
      "maxOutputCharacters": 20000,
      "graph": {
        "maximumTotalAttempts": 24,
        "maximumRepairAttempts": 2,
        "context": [
          { "kind": "other", "path": "design/GAME.md", "label": "game intent" }
        ],
        "nodes": [
          {
            "id": "mechanics",
            "role": "scout",
            "permissions": "read",
            "command": ["pi", "--mode", "mechanics-scout"]
          },
          {
            "id": "telemetry",
            "role": "scout",
            "permissions": "read",
            "command": ["pi", "--mode", "telemetry-scout"]
          },
          {
            "id": "builder",
            "role": "implementer",
            "permissions": "write",
            "dependsOn": ["mechanics", "telemetry"],
            "command": ["pi", "--mode", "write"]
          },
          {
            "id": "feel-review",
            "role": "critic",
            "permissions": "read",
            "dependsOn": ["builder"],
            "command": ["pi", "--mode", "feel-review"],
            "repair": {
              "target": "builder",
              "outcomes": ["revise"],
              "maximumAttempts": 2
            }
          }
        ]
      }
    }
  }
}
```

Nodes become runnable after every `dependsOn` node reaches a terminal state. Independent read-only nodes run in parallel up to `maximumParallel`. A writer is always run alone: it never overlaps another writer or a read-only snapshot in the same graph. Dependency cycles, unknown dependencies, invalid repair targets, and contradictory permissions are rejected before a command starts.

Node fields:

- `id` is required. The default `command` adapter also requires `command`; commands may use `{candidate}`, `{experiment}`, `{objective}`, `{stage}`, `{contributor}`, `{node}`, and `{attempt}` substitutions.
- `adapter: "codex-app-server"` launches a real signed-in Codex thread and does not require `command`. It inherits the configured Codex model unless `model` is set. An explicit command can still override the App Server launcher for testing or a custom installation.
- `role` is one of `scout`, `planner`, `implementer`, `critic`, `judge`, or `worker`. It defaults to `worker`.
- `permissions` is `read` or `write`. `readOnly` is accepted as an equivalent boolean. An implementer defaults to write; every other role defaults to read.
- `dependsOn` names predecessor nodes.
- `when` conditionally runs a node after a direct predecessor produces one of the named outcomes. It can be one condition or an array, for example `{ "node": "review", "outcomes": ["revise"] }`.
- `context` adds candidate-local artifact references to the request. Graph-level context is included in every node request.
- `instructions` replaces the role's default instruction text.
- `maximumAttempts` retries a failed command activation and defaults to 1.
- `required: false` permits a failed optional node without failing the whole graph. Dependents can use `when` with the `failed` outcome to run a fallback.
- `repair` lets a read-only reviewer route `revise` (or configured outcomes) back to a directly preceding writer. The writer receives the review as an additional structured input, then all reviewers for that writer run again.
- `provider` and `model` identify the configured invocation backend. `billingMode` is `subscription`, `credits`, `metered`, or `unknown`. These may be set once on `agentTeam` and overridden per contributor. Configured identity is labeled as configured rather than presented as provider-verified telemetry.

`maximumTotalAttempts` caps every subprocess invocation, including retries and reviews. `maximumRepairAttempts` caps total writer revision rounds across the graph. Each repair edge also has its own `maximumAttempts`. Unresolved repairs are reported in result metadata instead of creating an unbounded loop.

The App Server adapter streams turn/item events, subscription token usage,
provider model reroutes, and native Codex collaboration calls. Collaboration
calls become child subagent nodes in the factory trace. It uses a strict outer
response envelope for stable `summary` and `outcome` fields while allowing
arbitrary structured findings and context inside a JSON payload. Read-only and
writer nodes receive corresponding Codex sandbox policies with unattended
approvals disabled.

## Structured handoffs and artifacts

A command contributor may return ordinary text, a JSON object, or log lines followed by a JSON object on the last line. Text remains the fallback. The App Server adapter expands its strict wire envelope into the same structured result. A result may contain:

```json
{
  "summary": "Movement acceleration needs a shorter ramp",
  "outcome": "revise",
  "findings": [{ "metric": "time_to_full_speed", "observed": 0.8 }],
  "context": { "recommendedRampSeconds": 0.35 },
  "usage": {
    "provider": "openai",
    "model": "your-model-id",
    "inputTokens": 1200,
    "cachedInputTokens": 800,
    "outputTokens": 240,
    "reasoningTokens": 90,
    "costUsd": 0.012,
    "costSource": "provider-reported",
    "pricingVersion": "2026-08-01",
    "billingMode": "metered",
    "identitySource": "provider-reported"
  },
  "artifacts": [
    { "kind": "telemetry", "path": ".factory/evidence/movement.json" }
  ]
}
```

The parsed object, bounded text fallback, outcome, and candidate-local artifact references are passed to dependent nodes. Artifact and context paths cannot escape the candidate root. A parsed `output.json` and `prompt-manifest.json` are preserved alongside the request, stdout, and stderr. The prompt manifest identifies applicable `AGENTS.md` files, the versioned role charter, task, boundaries, context, handoffs, history, adapter, and provider-reported thread/turn instruction sources. It does not claim access to hidden provider system prompts.

Every subprocess receives its structured request path in `GAMEFACTORY_REQUEST`. `GAMEFACTORY_CANDIDATE`, `GAMEFACTORY_STAGE`, `GAMEFACTORY_CONTRIBUTOR`, `GAMEFACTORY_NODE`, and `GAMEFACTORY_ATTEMPT` are also set. Graph attempts are stored separately below `.factory/agent-team/<experiment>/graph/<node>/attempt-<n>/`, so retries and repair provenance never overwrite the original evidence.

Each attempt has a stable `invocationId` and `parentInvocationId`. Missing cost remains unreported rather than being interpreted as zero. Aggregate team cost is exposed to campaign budgeting only when every invocation reports cost.

Read-only nodes are protected with content-aware Git snapshots that exclude `.factory`. Any meaningful project mutation fails the agent run. This is mutation detection, not an operating-system sandbox; commands should still be treated according to the configured extension security policy.
