# Unity minimal preset

This preset proves one bounded Unity 6 experience before visual production. It
uses the Unity CLI, `com.unity.pipeline`, and the factory-owned bridge to run a
real scene through Unity Input System controls and preserve a causal trace plus
continuous camera frames.

## Project setup

1. Install the Pipeline package:

   ```powershell
   unity pipeline install --project-path <project>
   ```

2. Copy `bridges/unity/com.gamefactory.bridge` into the Unity project's
   `Packages/com.gamefactory.bridge` directory.
3. Add `com.gamefactory.bridge` and a Unity-6-compatible
   `com.unity.inputsystem` version to `Packages/manifest.json`.
4. Copy `scenario.template.json` to
   `Assets/GameFactory/first-session.scenario.json` and bind its scene, actor,
   target, state observation, and physical controls.
5. Copy `campaign.template.json` into the project and run it with a factory
   config derived from `factory.preset.json`.

The bridge is immutable during experiments. Game code may not produce or edit
the trusted verdict, trace authority, or capture metadata.
