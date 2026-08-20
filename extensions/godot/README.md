# Godot extension

The Godot extension can require an embodied gameplay proof in `campaign.parameters.godot.embodiedProof`. This is stricter than a passing scenario: it rejects direct function replay and static presentations before semantic gameplay or visual review.

When `embodiedProof` is enabled, the extension launches `runtime/embodied_probe.gd` from outside the candidate project. The candidate supplies ordinary game code; the campaign supplies a small black-box probe contract. The extension—not the game—injects shipping input, observes runtime nodes and properties, captures frames, and writes the trusted result.

Configure one shared probe at `parameters.godot.embodiedProbe`, or override it in an individual scenario's parameters:

```json
{
  "actorPath": "World/Player",
  "targetPath": "World/Villager",
  "interactionAction": "interact",
  "interactionRange": 48,
  "captureEveryFrames": 10,
  "stateObservations": [
    { "id": "delivery", "nodePath": "World/Villager", "property": "has_potion", "state": "potion-delivered" }
  ],
  "steps": [
    { "action": "move_right", "kind": "axis", "pressed": true, "frames": 90 },
    { "action": "move_right", "kind": "axis", "pressed": false, "frames": 1 },
    { "action": "interact", "kind": "action", "pressed": true, "frames": 2 },
    { "action": "interact", "kind": "action", "pressed": false, "frames": 15 }
  ]
}
```

Actor and target paths are relative to the configured scenario root. Actions must already exist in the shipping `InputMap`; observations read ordinary runtime properties. Missing nodes, actions, consequences, motion, or captures fail closed. The generic candidate-owned `addons/gamefactory/scenario_runner.gd` remains available only for campaigns that do not enable `embodiedProof`.

Embodied proof automatically uses Godot's normal renderer because continuous viewport capture is mandatory; `rendered: false` is not used for this lane.

The factory probe produces two kinds of artifacts:

- A `replay` or `telemetry` JSON artifact with `metadata.protocol` set to `gamefactory.embodied-trace/v1`.
- Continuous PNG frame artifacts with `metadata.evidenceRole` set to `continuous-frame`.

The trace JSON has this minimum shape:

```json
{
  "apiVersion": "gamefactory.embodied-trace/v1",
  "producer": "factory-owned-godot-probe",
  "samples": [
    {
      "time": 0.1,
      "input": { "delivery": "godot-input-event", "kind": "axis", "action": "move_right" },
      "actor": { "id": "player", "visible": true, "position": { "x": 24, "y": 48 } },
      "events": []
    },
    {
      "time": 1.2,
      "input": { "delivery": "godot-input-event", "kind": "action", "action": "interact" },
      "actor": { "id": "player", "visible": true, "position": { "x": 72, "y": 48 } },
      "events": [
        { "kind": "spatial-interaction", "targetId": "target", "distance": 8, "range": 16, "outcome": "applied" },
        { "kind": "state-change", "cause": "player-input", "state": "target-activated" }
      ]
    }
  ]
}
```

The probe injects Godot `InputEventAction`s through the same `InputMap` actions used in normal play. It never calls movement, interaction, resolution, or state-transition helpers directly.

When the proof passes, evaluator-produced report and trace artifacts receive `metadata.evidenceClass: embodied-gameplay` and `metadata.verified: true`. Project v2 slices with `evidence.requireEmbodiedGameplay` accept only those trusted artifacts.
