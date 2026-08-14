# Emberline: The Fuse Fights Back

A compact mouse-first Godot 4 tower defense about protecting one living fuse.
Seat Spark, Cooling Bell, and Striker instruments in nine fixed brass sockets,
then compose their contact order across four waves and a Furnace Warden boss.

The fuse has five event-driven physical bands. `FLASHBOIL` (Bell then Spark)
buys burst damage but heats the current band. `TEMPER` (Spark then Bell) makes
the threat brittle and cools the band. `SHATTER` consumes chilled or brittle
and vents it again. A Rivet Carrier that enters a `HOT` band splits it into
`FRAYED`; threats move faster on that band. The Warden's visible clamp is
loosened by Bell and broken by Striker.

Controls:

- Mouse: choose, place, inspect, masterwork, dismantle, start a wave, pause,
  change speed, reduce effects, mute, or restart.
- `1` / `2` / `3`: choose Spark / Bell / Striker.
- `Space`: start a ready wave.
- `P`: pause or resume. Building remains available while paused.
- `R`: request restart during a run; replay immediately from an ending.

The deterministic GameFactory hooks report observed simulation state for fuse
transitions, reaction order, enemy roles, Warden clamp state, economy, waves,
core damage, defeat, and replay. They do not report a proxy fun or polish score.
The defensive and aggressive acceptance plans use no fixture funding: both
start with 110 credit, buy and rebuild through the player economy, and preserve
an explicit conservation ledger. Fixture-only funding remains isolated to the
engine-native visual capture harness, whose title, planning, and late-wave
Warden frames are not presented as human playtest evidence.

## Final verification

The promoted build passes the defensive, aggressive, and defeat-to-replay
Godot scenarios. Each reaches a four-wave victory, resolves the Warden clamp,
uses zero fixture credit, and preserves the credit ledger. The replay scenario
also reaches defeat, restarts once, and then wins.

Rendered engine evidence lives under `levels/evidence/final/`: three required
still views plus a deterministic Spark/Bell/Striker contact-to-settle sequence.
Those frames demonstrate implemented visual timing; they are controlled engine
evidence, not a human judgment that the game is fun.
