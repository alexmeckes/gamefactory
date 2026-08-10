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

Use separate commands or the same Pi/Codex command with role-aware prompts. The
request contains `stage`, `instructions`, upstream evidence, campaign history,
the objective, and the candidate root.

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
        { "id": "systems", "command": ["pi", "--mode", "scout"] },
        { "id": "gameplay", "command": ["pi", "--mode", "scout"] }
      ],
      "planner": { "id": "lead", "command": ["pi", "--mode", "plan"] },
      "implementer": { "id": "builder", "command": ["pi", "--mode", "write"] },
      "critics": [
        { "id": "regression", "command": ["pi", "--mode", "review"] }
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

Nested parallelism can multiply quickly. Keep tournament concurrency and team
`maximumParallel` explicit, and rely on campaign wall-time, experiment, crash,
and cost budgets.
