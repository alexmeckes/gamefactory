# Writing extensions

An extension is a directory with `factory.extension.json` and a lazily loaded
JavaScript entry point.

```json
{
  "name": "acme.physics",
  "version": "1.0.0",
  "apiVersion": "1.0",
  "entry": "dist/index.js",
  "activation": ["evaluator:acme.physics"],
  "contributes": { "evaluator": ["acme.physics"] },
  "permissions": ["process:engine"]
}
```

```ts
import { defineExtension } from "@gamefactory/extension-sdk";

export default defineExtension((api) =>
  api.register("evaluator", "acme.physics", new PhysicsEvaluator())
);
```

Rules that keep extensions healthy:

- Declare every capability and external permission in the manifest.
- Do no work at module import time; allocate resources during activation.
- Dispose processes, sockets, and temporary state.
- Keep scenario schemas opaque to the core and version them at the provider.
- Emit deterministic metrics and retain raw artifacts needed to audit them.
- Never modify the baseline directly. Agents receive candidate roots only.
- Put heavyweight SDKs in the extension that needs them.
- Ship contract and fixture tests; the mock extension is the smallest example.

The command-agent adapter is deliberately model-neutral. Its configured process
receives `GAMEFACTORY_REQUEST` and `GAMEFACTORY_CANDIDATE`, so Codex, Pi, or a
local agent can plug in without becoming a core dependency.

Set optional `commandAgent.provider` and `commandAgent.model` values to retain
backend identity. A command may return a JSON object on its last stdout line
with `summary` and `usage`. Usage accepts `inputTokens`, `cachedInputTokens`,
`outputTokens`, `reasoningTokens`, `totalTokens`, `costUsd`, `costSource`, and
`pricingVersion`. Invalid usage metadata is ignored rather than changing an
otherwise successful agent result.

For orchestration rather than a single process, use the
[multi-agent extensions](multi-agent.md). A team still implements `AgentDriver`,
and a tournament still implements `Workflow`, so neither expands the kernel.
