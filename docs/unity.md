# Unity workflow

GameFactory supports Unity 6 through `extensions/unity`. The core remains
engine-neutral: Unity contributes `unity.engine`, `unity.scenario`,
`unity.evidence`, and `unity.scenario` evaluator capabilities through the same
interfaces used by other host adapters.

## Prerequisites

- Unity Editor 6.0 or later.
- Unity CLI authenticated with `unity auth login`.
- `com.unity.pipeline`, installed with `unity pipeline install --project-path`.
- Unity Input System.
- The host-owned `bridges/unity/com.gamefactory.bridge` package, referenced by
  absolute `file:` path from the project manifest rather than copied into the candidate.

The bridge registers `gamefactory_prepare_playmode` and
`gamefactory_run_scenario` with Unity Pipeline. Preparation preserves the user's
Play Mode settings and temporarily disables domain reload so the Pipeline
request survives an evidence run. The scenario restores those settings when it
finishes.

By default the adapter uses one-shot `unity run` processes. Set
`parameters.unity.connectedEditor` to `true` for projects whose startup plugins
keep a fresh Editor busy: open the project once, wait for `unity status` to say
`ready`, and GameFactory will issue both commands through `unity command`.

## Evidence contract

A scenario is a candidate-relative `gamefactory.unity-scenario/v1` JSON file.
It names a scene, visible actor, target, observable runtime members, and physical
Input System controls. The factory bridge—not candidate game code—queues those
controls, observes transform and state changes, renders camera frames, and writes
`gamefactory.embodied-trace/v1`.

Passing embodied evidence requires:

- multiple shipping `unity-input-system` events;
- a visible actor and measurable displacement;
- an in-range interaction;
- a state change attributable to player input;
- multiple byte-distinct engine frames.

Trusted artifacts carry `metadata.evidenceAuthority: "factory-engine"` and
`metadata.engine: "unity"`, plus the factory-stamped hash of the verified
host bridge. Project evidence gates and Gemini review consume
those generic roles rather than matching Unity-specific evaluator names.

Use `presets/unity-minimal` as the starting point. Production visuals remain a
dependent slice after a human approves the embodied runtime proof.
