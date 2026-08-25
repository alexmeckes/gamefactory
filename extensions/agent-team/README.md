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
      "handoffCharacters": 10000,
      "maximumHandoffArtifacts": 24,
      "historyLimit": 6,
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
      "handoffCharacters": 12000,
      "maximumHandoffArtifacts": 24,
      "graph": {
        "enforceWriteContracts": true,
        "reuseCheckpoints": true,
        "maximumTotalAttempts": 24,
        "maximumRepairAttempts": 2,
        "externalInvalidationTargets": {
          "evaluator:runtime-proof": ["builder"]
        },
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
            "writePaths": ["src/**", "assets/**"],
            "dependsOn": ["mechanics", "telemetry"],
            "command": ["pi", "--mode", "write"]
          },
          {
            "id": "render-evidence",
            "role": "worker",
            "permissions": "read",
            "dependsOn": ["builder"],
            "refreshAfterRepair": true,
            "command": ["game", "--capture"]
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
              "maximumAttempts": 2,
              "allowedPaths": ["src/presentation/**", "assets/**"],
              "preserve": ["render-evidence"]
            }
          }
        ]
      }
    }
  }
}
```

Nodes become runnable after every `dependsOn` node reaches a terminal state. A
triggered repair edge is handled before downstream scheduling: the writer and
its completed evidence/reviewer chain rerun first, so rejected state cannot
flow into dependent nodes. Independent read-only nodes run in parallel up to
`maximumParallel`. A writer is always run alone: it never overlaps another
writer or a read-only snapshot in the same graph. Dependency cycles, unknown
dependencies, invalid repair targets, and contradictory permissions are
rejected before a command starts.

Node fields:

- `id` is required. The default `command` adapter also requires `command`; commands may use `{candidate}`, `{experiment}`, `{objective}`, `{stage}`, `{contributor}`, `{node}`, and `{attempt}` substitutions.
- `adapter: "codex-app-server"` launches a real signed-in Codex thread and does not require `command`. It inherits the configured Codex model unless `model` is set. An explicit command can still override the App Server launcher for testing or a custom installation.
- `threadRetention` controls Codex conversation persistence for App Server nodes. `ephemeral` is the default: one blank candidate root feeds in-memory worker forks, finished workers unsubscribe immediately, and the root plus shared App Server process are removed when the last parallel candidate finishes. `archive` persists each worker but moves it out of the active task list after completion. `debug` persists workers in the active task list while still unsubscribing them from live events. It may be set once on `agentTeam` and overridden per node.
- `role` is one of `scout`, `planner`, `implementer`, `critic`, `judge`, or `worker`. It defaults to `worker`.
- `permissions` is `read` or `write`. `readOnly` is accepted as an equivalent boolean. An implementer defaults to write; every other role defaults to read.
- `writePaths` is the canonical mutation contract for a writer or factory-native driver. With graph-level `enforceWriteContracts: true`, every writer must declare it, repair scopes must cover the target writer contract, driver-declared side effects must fit it, and mutations outside it fail before downstream work proceeds. Legacy `driverWritePaths` is read only for migration.
- `authority` is `observe`, `propose`, `mutate-candidate`, `mutate-spec`, or `approve`. It defaults from the role and permission. Mutation authority requires write permission; all other authorities require read permission. A graph may have at most one spec owner.
- `dependsOn` names predecessor nodes.
- `when` conditionally runs a node after a direct predecessor produces one of the named outcomes. It can be one condition or an array, for example `{ "node": "review", "outcomes": ["revise"] }`.
- `context` adds candidate-local artifact references to the request. Graph-level context is included by default; `inheritContext: false` lets a node opt out when large visual references are irrelevant to its job.
- `instructions` replaces the role's default instruction text.
- `skills` binds only the repo-scoped Codex skills required by this contributor, for example `["frame-core-game"]` or `[{ "name": "audit-game-build", "sha256": "...", "required": true }]`. Required skills are loaded from `.agents/skills`, frontmatter-checked, optionally hash-pinned, and fail before any contributor launches. Advisors inherit the primary node's bindings unless they declare their own.
- `maximumAttempts` retries a failed command activation and defaults to 1.
- `timeoutSeconds` sets a per-attempt safety backstop and defaults to 900. Long-running Sol/xhigh writers and visual reviewers can override it without forcing every scout to inherit the same runway. The value must be positive and no greater than 86400.
- `required: false` permits a failed optional node without failing the whole graph. Dependents can use `when` with the `failed` outcome to run a fallback.
- `advisory: true` is available on read-only `propose` nodes. A completed advisory may return a rejecting outcome such as `revise` and still feed required downstream synthesis or arbitration; an execution failure still blocks normally. Advisory nodes cannot own repair edges.
- `repair` lets a read-only reviewer route `revise` (or configured outcomes) back to a directly preceding writer. The writer receives the review as an additional structured input, then derived evidence and reviewers rerun in dependency order. Optional `allowedPaths` fails closed if the repair mutates another surface. Optional `preserve` names direct read-only contracts whose accepted outcomes are included as frozen constraints and must survive re-evaluation.
- `invalidationTargets` maps terminal rejection outcomes to the upstream writer checkpoints made stale by that outcome. Each named writer is a causal seed, so writer checkpoints downstream of it are invalidated too. An explicit empty list preserves all writer checkpoints, as for a spec-amendment return edge. Without a mapping, only the nearest upstream writers and their writer descendants are invalidated. External mappings accept either an evaluator id or the more precise `evaluator#violation-code`; evaluator-provided `causalNodeIds` take precedence.
- `refreshAfterRepair: true` remains accepted as an explicit documentation hint. Refresh is now automatic: repairing a writer increments its generation and reruns every completed dependent writer, evidence node, reviewer, and judge in dependency order. Required nodes cannot complete against stale writer generations.
- `adapter: "agent-driver"` plus `driver: "<agent capability>"` invokes another lazily activated GameFactory agent extension inside the graph. This is intended for bounded tools such as `sam3.segment`; it cannot recursively invoke `agent.team`, and its artifacts and metadata join the ordinary handoff/provenance stream. The delegated `AgentRequest.invocation` carries the node id, concrete attempt, reason, instructions, and provider-neutral upstream inputs, including output-contract retry feedback.
- `provider` and `model` identify the configured invocation backend. `billingMode` is `subscription`, `credits`, `metered`, or `unknown`. These may be set once on `agentTeam` and overridden per contributor. Configured identity is labeled as configured rather than presented as provider-verified telemetry.

`maximumTotalAttempts` caps every subprocess invocation, including retries and reviews. `maximumRepairAttempts` caps total writer revision rounds across the graph. Each repair edge also has its own `maximumAttempts`. An unresolved required repair fails the gate and dependency-blocks required downstream work instead of creating an unbounded loop.

Graph-level `reuseCheckpoints: true` stores each successful writer's contracted output delta, declared evidence, structured handoff, semantic node identity, stable dependency identity, exact write-scope input/output state, and full candidate read-state before and after the writer below the factory data root. Semantic identity includes every execution-defining field: command/driver routing and candidate-local command-file contents, model settings, campaign and slice contracts, orchestration runtime fingerprint, role charter, project instructions, loaded skill-directory hashes, repair/invalidation policy, write scope, and referenced context contents. Every save has an exact generation id and remains provisional when the agent graph returns. The outer workflow promotes generations only after all hard evaluators accept the candidate. A graph rejection invalidates the causally named writer generations and their writer descendants immediately; an external evaluator rejection uses violation attribution or `externalInvalidationTargets` as causal seeds while accepting independent work. An unknown external rejection is conservative and invalidates all writer generations.

Provisional generations can resume across infrastructure attempts only in the same retained candidate and logical experiment lineage. An accepted generation may restore into another worktree only when its recorded write-scope input and full candidate read-state hashes match that worktree exactly; restoration applies a verified delta, preserves unrelated files, and checks the final output and read-state hashes. Same-worktree edits anywhere the writer could have read force execution again. Checkpoints are saved only after write-scope enforcement passes. Checkpoint, provider-availability, evaluator-availability, and write-guard failures are infrastructure failures, so workflows retain the candidate instead of recording a creative rejection; autoresearch also avoids charging a creative experiment or plateau step.

Graph-level `claimIds` declares the frozen contract claims visible to reviewers. When `enforceClaimedBlockers` is true—or any node declares authority explicitly—a rejecting `propose` or `approve` node must return structured blocker findings with existing `claimIds`. New scope is an `opportunity`, not a forced repair. Metadata reports `executionRetries`, creative `repairAttempts`, `advisorEscalations`, each writer generation, and the input generations reviewed by every node.

`handoffCharacters` is one total upstream-context budget for a node (default 12000, capped by `maxOutputCharacters`), divided across direct dependencies and compacted experiment history rather than granted separately to every source. `maximumHandoffArtifacts` is likewise one total artifact-reference allowance (default 24). `historyLimit` keeps only the newest experiment summaries (default 6; zero disables history); nested extension drivers receive the same compact history, not the original full records. Structured handoffs omit duplicated raw stdout, usage telemetry, and artifact arrays; artifacts travel through their separately bounded channel. Oversized structured payloads become a bounded summary with a pointer to the preserved full output. The complete effective instruction manifest is stored beside the request and referenced by path instead of embedded into every request body; an agent reads it only when it needs instruction-source audit details or bound skill content.

The App Server adapter streams turn/item events, subscription token usage,
provider model reroutes, and native Codex collaboration calls. Collaboration
calls become child subagent nodes in the factory trace. It uses a strict outer
response envelope for stable `summary` and `outcome` fields while allowing
arbitrary structured findings and context inside a JSON payload. Read-only and
writer nodes receive corresponding Codex sandbox policies with unattended
approvals disabled. Lifecycle progress includes the App Server process id plus
active and provider-loaded thread counts so the Observatory can distinguish
currently executing workers from conversations awaiting provider eviction.

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

The parsed object, bounded text fallback, outcome, and candidate-local artifact references are passed to dependent nodes. Artifact and context paths cannot escape the candidate root. A parsed `output.json` and `prompt-manifest.json` are preserved alongside the request, stdout, and stderr. The prompt manifest identifies applicable `AGENTS.md` files, bound skill names and SHA-256 identities, the versioned role charter, task, boundaries, context, handoffs, history, adapter, and provider-reported thread/turn instruction sources. Skill contents are explicit prompt layers, so replay does not depend on implicit provider discovery. It does not claim access to hidden provider system prompts.

Every subprocess receives its structured request path in `GAMEFACTORY_REQUEST`. `GAMEFACTORY_CANDIDATE`, `GAMEFACTORY_STAGE`, `GAMEFACTORY_CONTRIBUTOR`, `GAMEFACTORY_NODE`, and `GAMEFACTORY_ATTEMPT` are also set. Graph attempts are stored separately below `.factory/agent-team/<experiment>/graph/<node>/attempt-<n>/`, so retries and repair provenance never overwrite the original evidence.

Each attempt has a stable `invocationId` and `parentInvocationId`. Missing cost remains unreported rather than being interpreted as zero. Aggregate team cost is exposed to campaign budgeting only when every invocation reports cost.

Read-only nodes are protected with content-aware Git snapshots that exclude `.factory`. Any meaningful project mutation fails the agent run. This is mutation detection, not an operating-system sandbox; commands should still be treated according to the configured extension security policy.
