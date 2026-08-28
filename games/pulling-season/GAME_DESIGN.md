# Pulling Season — Game Design Revision 3

## The game

Pulling Season is a short first-person physics gardening comedy. You are an underqualified allotment worker managing three plots of oversized, temperamental vegetables. Every crop can be taken safely now or left to grow into something more valuable and harder to extract. Limited water and soil-loosening supplies force you to choose which risks to prepare for. Then you must physically preserve the wager by pulling, correcting, catching, carrying, and deciding whether the result is worth selling or sacrificing for recovery.

The game is not “pull one vegetable.” The game is deciding what to risk across the whole yard and living with the physical result.

## Player fantasy

Feel like a scrappy produce wrangler who can look across a messy yard, read three looming problems, form a plan, and barely turn an unruly harvest into a profitable season.

## Design pillars

1. **Read before acting.** Crop shape, growth, visible trait, soil, and remaining supplies support a prediction.
2. **Order is the gamble.** Resolving one plot advances every crop deliberately left behind by one visible growth step.
3. **The pull is embodied.** Grip, stance, movement, direction, and correction physically determine condition.
4. **Failure changes the plan.** Damage remains visible; Compost can recover resources at the cost of payout.
5. **One yard becomes a season.** Three plots, three escalating shifts, upgrades, save/resume, completion, and replay form a bounded small game.

## Core loop

1. Walk the yard and inspect all three plots.
2. Read crop family, growth state, trait, soil, and likely risk.
3. Choose a plot to resolve now and crops to leave growing.
4. Water with **Q**, loosen with **E**, or conserve supplies.
5. Grip and physically extract using movement and correction.
6. Catch the crop and settle it into a stable two-handed carry pose.
7. Deliver to **Market** for condition-sensitive coins or **Compost** for bounded recovery.
8. Watch unresolved crops advance one visible growth step.
9. Adapt the plan for the remaining plots.
10. Resolve all three plots, review the shift, buy at most one upgrade, and begin the next shift.

## Yard and growth structure

Three adjacent plots are simultaneously visible and reachable. The player can walk between them and inspect before committing. Crops do not grow on a wall-clock timer. Instead, resolving one plot advances the crops intentionally left behind.

That produces a legible order decision: harvest the easy turnip now while the beet and carrot become more valuable, or spend scarce preparation on a harder crop before another growth step increases its resistance and fragility.

The other plots must never be decorative. Their current crop, soil, and growth state are readable before the player chooses an order.

## First crop set

### Turnip

- Opening crop and cleanest introduction to grip, direct lift, and lateral correction.
- Round body and broad leaves make lift and rotation easy to read.
- Forgiving catch, but careless overpull can bruise the shoulder or snap leaves.

### Beet

- Increased lateral resistance and a greater need to rock, recenter, or loosen.
- Root and stem motion make twisting and asymmetric load visible.
- Poor correction can crack or fork the lower root.

### Long carrot

- Deepest, highest-potential, and most condition-sensitive crop.
- Requires staged extraction and a deliberate catch rather than one violent pull.
- Dense soil, extra growth, and poor preparation create obvious break risk.

Soil and traits vary the best plan so these crops do not collapse into one fixed sequence.

## Soil and preparation

Readable soil states include loose loam, dry crust, dense clay, watered soil, and fork-loosened soil.

- **Q — Water:** spends one water charge. Useful against dryness and brittleness, but the charge may matter more elsewhere and not every soil benefits equally.
- **E — Loosen:** spends one loosening charge. Reduces selected resistance or releases a snag, but unnecessary use wastes scarce preparation and may alter a crop’s pristine potential.
- **Conserve:** take neither preparation action and preserve supplies for another plot.

The player begins a shift with fewer charges than the number of possible uses. “Water and loosen everything” must never be the correct universal strategy.

## Traits and quality

Traits are visible geometry with mechanical consequences, not text modifiers pasted onto identical crops.

- **Dew-Veined:** responds distinctly to water and visibly communicates moisture potential.
- **Fork-Crowned:** has a snag-prone root shape that changes loosening value or correction.
- **Seed-Bearing:** offers greater benefit from another growth step while increasing a readable condition risk.

Quality tiers are **Common**, **Choice**, and **Prize**. Quality summarizes visible potential plus what survived the harvest. It is not a random rarity roll after pickup.

Value is attributable to crop family, growth opportunity, visible trait, preparation choice, intact or damaged condition, and catch/delivery handling.

## Extraction and carrying

The player grips deliberately, then uses body movement, mouse direction, and crop-specific correction while maintaining the pull. The crop visibly lifts, rotates, flexes, displaces soil, and accumulates damage in response.

After a deliberate catch, the crop settles into a stable two-handed carry pose. Carrying should communicate size and weight through gentle sway without forcing the player to continuously fight an awkward loose joint. Deliberate dropping and meaningful collisions can still worsen condition.

## Condition, Market, and Compost

Condition remains visible through the entire result: intact, root-bruised, catch-bruised, cracked or broken, and compost-grade.

**Market** pays coins based on crop, growth, quality, and condition.

**Compost** sacrifices payout to restore one bounded care resource or improve a later soil state. This converts failure into a new plan rather than a dead end. Compost must not become an automatic destination for every damaged crop or an exploit for duplicating supplies.

## Season structure

A complete season contains three escalating shifts. Each shift has three plots and ends after all crops are resolved.

- **Shift 1:** readable introductory combinations and the complete turnip → beet → long-carrot escalation, while still allowing order choice.
- **Shift 2:** remixed soil and trait combinations create stronger supply conflicts and invalidate the opening solution.
- **Shift 3:** toughest combinations and final contract pressure ask the player to use upgrades, recovery, and learned technique together.

Between shifts, the player receives a result and may buy at most one practical upgrade. The third result completes the season and opens a replayable challenge shift or a clean restart.

## Progression

Coins, supplies, chosen upgrades, completed plots, and current season state persist through save/resume. Upgrades change decisions or handling tolerance without automating the pull. The bounded set should target four to six useful choices, such as:

- One additional water charge
- One additional loosening charge
- Better grip recovery
- Safer catch or carry support
- A soil-reading aid
- A more forgiving recovery option

Exact upgrades remain a tuning decision. Linear stat inflation and mandatory upgrade paths are out of scope.

## Controls and interface

- **WASD:** move, position, and brace
- **Mouse:** look and direct correction
- **LMB:** grip, catch, carry, place
- **RMB:** sustain extraction/pull
- **Q:** water
- **E:** loosen soil
- **Escape:** pause, restart, and settings

The interface is restrained: one compact status block, three crop tabs, one short contextual prompt, and brief tension/correction feedback only while pulling. Explanatory paragraphs, debug terminology, giant destination arrows, and inventory-grid clutter are not part of the shipping view.

## Visual and audio direction

The world uses an original deliberately simple low-poly style:

- Chunky faceted silhouettes
- Oversized vegetables and blocky gloves
- Two to four broad flat colors per prop
- Sparse texture and shared matte materials
- Restrained daylight and practical lamps
- No realistic PBR grime, cinematic fog, micro-foliage, or glossy material drift

Audio and motion communicate soil strain, safe correction, root damage, release, catch, condition, scale weight, and delivery. They support causality rather than decorative spectacle.

## Complete small-game scope

Revision 3 ships:

- One authored single-player yard
- Three simultaneous plots
- Turnip, beet, and long carrot
- Multiple soil states and three meaningful visible traits
- Growth-by-harvest-order
- Water, loosen, and conserve decisions
- Three distinct physical extraction patterns
- Stable carrying and deliberate placement/drop
- Visible damage and earned quality
- Market and Compost
- Three escalating shifts
- Bounded upgrades
- Save/resume and restart
- Season completion and replayable challenge combinations
- Original simple low-poly production presentation

## Non-goals

- Cooperative multiplayer
- Open world or NPC schedule simulation
- A large crop catalog
- Crafting trees or broad inventory management
- Real-time crop timers or calendar simulation
- Farming automation
- Combat, crime, or drug themes
- Copying another game’s protected characters, assets, props, layouts, setting, or branding
- Realistic rendering

## Acceptance boundary

Automation can prove that shipping input causes real crop, soil, condition, delivery, progression, save, and restart transitions. It cannot prove that the controls make sense, the visual direction works, or the game is fun. Those require direct human play.

The canonical machine-readable contract is [game-spec.json](game-spec.json). Revision evidence and synthetic counterfactuals are recorded in [design/game-spec-r3-review.json](design/game-spec-r3-review.json).
