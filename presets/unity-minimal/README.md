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

2. Add `com.gamefactory.bridge` to `Packages/manifest.json` as an absolute
   `file:` reference to GameFactory's host-owned
   `bridges/unity/com.gamefactory.bridge` directory. Do not copy it into the project.
3. Add a Unity-6-compatible `com.unity.inputsystem` version to the same manifest.
4. Copy `scenario.template.json` to
   `Assets/GameFactory/first-session.scenario.json` and bind its scene, actor,
   target, state observation, and physical controls.
5. Copy `campaign.template.json` into the project and run it with a factory
   config derived from `factory.preset.json`.

The bridge is outside candidate mutation authority and its executable hash is
pinned before evidence capture. Game code may not produce or edit the trusted
verdict, trace authority, or capture metadata.
