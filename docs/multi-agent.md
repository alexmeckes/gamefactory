# Multi-agent execution

GameFactory supports two independent forms of concurrency without adding agent
logic to the kernel.

## Team pipeline

`agent:agent.team` operates inside one candidate worktree:

```text
parallel read-only scouts
          ↓
one read-only planner
          ↓
one writing implementer
          ↓
parallel read-only critics
```

Only the implementer may modify project files. Before and after every read-only
stage, the extension captures a content-aware Git snapshot and rejects any
mutation outside `.factory`. Every contributor receives a structured request in
`GAMEFACTORY_REQUEST`; stdout, stderr, timing, command, role, and artifacts are
recorded as typed contributor provenance.

Use separate commands, the same Pi/Codex command with role-aware prompts, or the
native Codex App Server adapter. The request contains `stage`, `instructions`,
upstream evidence, campaign history, the objective, and the candidate root.

Each invocation also writes `prompt-manifest.json`. It records the effective
instruction layers GameFactory controls: applicable project `AGENTS.md` files,
the campaign objective and path boundaries, the versioned role charter, node
task, context references, upstream handoffs, and bounded history. With App
Server it additionally records provider-reported instruction sources and
thread/turn lineage. Hidden provider system prompts are intentionally not
claimed or reconstructed.

## Codex App Server adapter

For a real Codex contributor, omit a hardcoded command and select the adapter:

```json
{
  "id": "builder",
  "role": "implementer",
  "adapter": "codex-app-server",
  "readOnly": false,
  "instructions": "Implement the strongest plan and leave the project runnable."
}
```

GameFactory starts a persistent `codex app-server --listen stdio://` process,
creates an isolated thread per invocation, and streams turn, item, token, model,
and collaboration events into the trace. Native Codex collaboration calls are
represented as child subagent nodes. Read-only roles receive a read-only
sandbox; writers receive workspace-write access scoped to their candidate. The
adapter uses `approvalPolicy: never`, so the campaign cannot pause at an
unattended approval dialog. By default it inherits the signed-in Codex model
instead of inventing a model label.

`examples/godot/campaign.multi-agent.json` is the real App Server campaign.
`campaign.multi-agent.fixture.json` is the deterministic smoke equivalent.

The legacy pipeline remains a simple automation recipe. For task-specific
Codex-style orchestration, `agentTeam.graph` defines a bounded DAG of readers
and writers with dependencies, structured JSON handoffs, conditions, retries,
and critic-to-writer repair edges. Readers may fan out; writers are always
serialized within a candidate. The graph validates cycles, dependencies, paths,
permissions, and attempt caps before launching commands. See
`extensions/agent-team/README.md` for the complete schema.

## Tournament workflow

`workflow:tournament` creates several independent candidates from one baseline:

```text
baseline ─┬─ candidate 1 → agent/team → evaluator waterfall ─┐
          ├─ candidate 2 → agent/team → evaluator waterfall ─┼→ rank → one winner
          └─ candidate 3 → agent/team → evaluator waterfall ─┘
```

Candidate work is concurrency-bounded. All candidates finish evaluation against
the same baseline before selection. Ranking uses the configured primary metric,
direction, minimum delta, hard failures, and experiment ID as a stable tie-break.
Losers are discarded and exactly one passing improvement is accepted.

The control plane remains serialized:

- budget leases are reserved before branches start;
- JSONL writes share a per-path queue;
- lifecycle transitions are written to a durable phase journal;
- events are delivered in order;
- Git acceptance is locked per repository and verifies the original base commit;
- only the winner can mutate the baseline;
- candidate artifacts are copied into the content-addressed artifact store before
  any worktree is removed.

## Tournament configuration

```json
{
  "workflow": "tournament",
  "parameters": {
    "tournament": {
      "workspace": "git.worktree",
      "agents": ["agent.team"],
      "candidateCount": 3,
      "concurrency": 2,
      "evaluators": [
        { "id": "project.fast-gates", "cost": 1 },
        { "id": "godot.scenario", "cost": 10 }
      ]
    },
    "agentTeam": {
      "maximumParallel": 4,
      "scouts": [
        { "id": "systems", "adapter": "codex-app-server" },
        { "id": "gameplay", "adapter": "codex-app-server" }
      ],
      "planner": { "id": "lead", "adapter": "codex-app-server" },
      "implementer": { "id": "builder", "adapter": "codex-app-server" },
      "critics": [
        { "id": "regression", "adapter": "codex-app-server" }
      ]
    }
  }
}
```

Evaluator `cost` controls cheapest-first order; it is a relative scheduling hint,
not a dollar estimate. Evaluators stop at the first hard failure.

## Choosing the mode

- Use `autoresearch + command.agent` for the smallest deterministic loop.
- Use `autoresearch + agent.team` when one candidate benefits from specialists.
- Use `tournament + command.agent` to compare independent hypotheses cheaply.
- Use `tournament + agent.team` for high-value vertical slices where additional
  compute is justified.

Use the command adapter for deterministic fixtures, local models, or other
providers. Use App Server when Codex is the orchestrated agent runtime and you
want first-class lineage, streamed items, usage, cancellation, and native
subagent visibility.

Nested parallelism can multiply quickly. Keep tournament concurrency and team
`maximumParallel` explicit, and rely on campaign wall-time, experiment, crash,
and cost budgets.
