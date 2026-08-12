# Pulse Runner

Pulse Runner is a tiny playable Godot game and an end-to-end GameFactory fixture. Move the blue player, collect green pulses, and avoid the red drones.

## Play it

Open this folder in Godot 4 and run the project. Use WASD or the arrow keys to move and Enter to restart after a round.

The gameplay parameters live in `tuning.json`, which is the only surface the example campaigns allow agents to change.

## Test it with GameFactory

To create a new brief through the interactive multiple-choice intake:

```powershell
npm run factory -- intake "A short neon movement game about chosen risk" --config examples/godot/factory.config.json --output examples/godot/game.brief.json
```

Every question offers **Figure it out**, which preserves that decision for design-agent exploration.

From the repository root, with `GODOT_BINARY` pointing to a Godot 4 console executable:

```powershell
npm run smoke:godot
npm run smoke:godot:multi-agent
npm run smoke:godot:assets
npm run smoke:godot:discovery
npm run run:godot:codex
```

The first command exercises a linear autoresearch loop. The second runs
deterministic fixture teams in independent worktrees and accepts at most one
winner. The final command runs the real two-candidate Codex App Server campaign:
parallel systems and player-experience scouts, a lead planner, a protected
builder, and parallel regression and experience critics. It uses the model in
the signed-in Codex configuration unless the campaign specifies one.

Pulse Runner itself predates the factory run: its initial playable Godot scene
and script were authored directly, then the factory was used to tune, test, and
compare isolated variants. The deterministic `tools/team-role.mjs` campaign
proved scheduling and evidence flow; it was never an LLM-generated game. The
App Server campaign is the first example here that launches real Codex agents.

The original scenario uses a seeded controller so candidates are compared on identical play. Its legacy `fun_score` remains for compatibility, while new design campaigns call the same behavioral proxy `scenario_score`; neither is treated as human evidence of fun.

The asset smoke campaign starts from the procedural enemy fallback, generates three real drone candidates, checks PNG and manifest integrity, enforces the pinned `pulse-runner-neon@1.0.0` profile from `style-profile.json`, imports on-style candidates into Godot, captures them during play, and accepts one winner. Its structured brief is `asset-brief.json`; rejected sources remain under `asset-sources`, while accepted production files are limited to `assets/enemies/drone.png` and `assets.manifest.json` inside the isolated smoke repository.

The discovery campaign pins `design.intent.json`, creates three different design hypotheses, and runs novice, optimizer, and survivor policies across two scenario lengths and two seeds. It recommends one prototype after 36 Godot playtests but discards all three worktrees; choosing a creative direction remains a human decision.
