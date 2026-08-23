# GameFactory Unity Bridge

This embedded Unity 6 package exposes `gamefactory_run_scenario` through
`com.unity.pipeline`. The command injects real Unity Input System control events,
observes a visible actor and runtime state, captures camera frames, and writes
`gamefactory.embodied-trace/v1` evidence beneath the factory-owned output path.

Copy this package to `Packages/com.gamefactory.bridge` in the Unity project and
add these dependencies to `Packages/manifest.json`:

```json
{
  "dependencies": {
    "com.gamefactory.bridge": "file:com.gamefactory.bridge",
    "com.unity.inputsystem": "<project-compatible-version>"
  }
}
```

Install `com.unity.pipeline` with:

```powershell
unity pipeline install --project-path <project>
```

The factory invokes the bridge with a one-shot Editor process:

```powershell
unity run <project> --command gamefactory_run_scenario -- --request <request.json> --output <result.json>
```

The scenario contract names an `Assets/...` scene, hierarchy paths for the actor
and target, state members to observe, and physical Input System control paths such
as `<Keyboard>/d` and `<Keyboard>/e`. Candidate code never writes the verdict.
