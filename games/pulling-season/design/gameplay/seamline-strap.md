# Seamline Strap gameplay candidate

## Supported hypothesis

A single pre-looped strap can add a readable setup choice without a tool menu: the body position where the line first becomes taut establishes the crop-side load angle, and continued player movement must supply and steer the extraction. The likely release seam is visible but deliberately imperfect, so the player has evidence rather than a revealed solution.

This revision assumes one concise contextual hint plus the staged handbar, slack line, soil seam, crop scale, and growth pulse are enough for a first-time player to discover the encounter. That assumption remains unproven until direct human play.

## Player-facing causal chain

1. Read the smaller crop, the open soil seam, the slack strap, and the dormant next bed. Right mouse visibly performs the one allowed wait/grow commitment; ignoring it preserves the smaller, more tolerant early crop.
2. Approach with W and hold left mouse near the handbar. Movement inside the slack radius visibly routes the line but cannot advance extraction.
3. The first taut route produces a crop lean and affected soil sector. Sustained outward or backward movement along the seam advances yield; merely holding the grip does not.
4. Loading across roots turns the strap and soil marks red, twists the crown, drags the hands and camera, and accumulates reversible strain before a persistent bruise. Sidestepping toward the seam reduces that same strain; release retains route and consequence while allowing a physical reposition and regrip.
5. Extraction leaves the crop collision-active and tethered through the held grip. Lateral handling can still bruise it. Releasing drops the result; Space can acknowledge only after the visible result exists.
6. Acknowledgement keeps the result in the world and reveals a spatial next-bed cue selected from early, late, or damaged outcome state.

## Stable shipping boundaries

- Mouse movement: free first-person look.
- WASD: body-relative movement, setup routing, sustained pull, correction, and result handling.
- Left mouse held/released: contextual strap or result grip; there is no latch or alternate grip key.
- Right mouse: the visible one-step growth wager before gripping.
- Space: post-result acknowledgement only.

The preserved factory observation members are `Harvested`, `GripActive`, `PullProgress`, `GrowthStage`, `Condition`, and `Acknowledged`. The runtime hierarchy remains `World/Player`, `World/Crop`, and `World/NextCrop` under `Assets/Scenes/Main.unity`.

## Human gate

Automation may verify input causality, deterministic alternatives, quiescence, persistent state, and regression safety. It cannot establish that the handbar and timing wager are discoverable, the warning and correction are understood, the controls feel good, the 60-to-90-second pacing lands, or the encounter is fun.

A clean-start human session should therefore record:

- whether the player predicts an early-versus-late tradeoff before committing;
- whether they understand that body position routes the strap and continued movement supplies load;
- whether they interpret red twist as recoverable and attempt a physical correction;
- whether they correctly attribute crop condition and can form a next-bed plan;
- completion time, control comprehension, feel, desire to continue, and explicit approval or rejection.

Stop before production art until that gate passes.

