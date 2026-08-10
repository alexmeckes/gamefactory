# Agent team extension

`agent.team` runs a bounded, auditable pipeline inside one candidate:

1. read-only scouts run in parallel;
2. one read-only planner receives their outputs;
3. one implementer receives the findings and plan and may write to the candidate;
4. read-only critics run in parallel against the implementation.

Configure it in `campaign.parameters.agentTeam`. A contributor may be a command array or a named object. Commands support the same `{candidate}`, `{experiment}`, and `{objective}` substitutions as `command.agent`, plus `{stage}` and `{contributor}`.

```json
{
  "parameters": {
    "agent": "agent.team",
    "agentTeam": {
      "maximumParallel": 4,
      "maxOutputCharacters": 20000,
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

Every subprocess receives its structured request path in `GAMEFACTORY_REQUEST`. `GAMEFACTORY_CANDIDATE`, `GAMEFACTORY_STAGE`, and `GAMEFACTORY_CONTRIBUTOR` are also set. Requests, stdout, and stderr are stored below `.factory/agent-team/<experiment>/` and returned as artifacts.

Read-only roles are protected with content-aware Git snapshots that exclude `.factory`. Any project mutation by a scout, planner, or critic fails the agent run. Parallelism is limited by `maximumParallel` (default 4, maximum 32), and only the implementer is permitted to write.
