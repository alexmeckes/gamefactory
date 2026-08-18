# Alchemy Delivery Boys — visual boundary

## Desired feel

A cheerful, authored pixel-art village comedy: warm apothecary clutter, readable glass and liquid, expressive couriers, and villagers whose reactions carry the result. It should feel like a real small premium game screen, not concept art pasted behind generic panels.

## Production order

Gameplay proof remains visually provisional. After proof, direct complete 480×270 gameplay screens for at least mixing, route commitment, delivery consequence, and evening follow-up. Review those screens for hierarchy and interaction clarity before decomposing them into runtime assets. Every isolated asset must retain lineage to the approved screen target and be recomposed in-engine at the approved scale.

## Pixel system

- Native canvas: 480×270, integer scaling, nearest-neighbor filtering.
- Use intentional clusters, silhouettes, and a restrained village palette; do not simulate detail with noisy single pixels.
- Potion color, clarity, bubbles, temperature, charge, and instability need a consistent visual grammar.
- Characters require readable idle, carry, travel, delivery, success, and mishap states where used.
- Use generated imagery only as approved whole-screen direction or traceable source material. It is never automatically a runtime asset.

## Interface system

- Prefer hybrid typography: expressive pixel lettering for the title and short labels, highly legible non-pixel or carefully sized bitmap text for requests and explanations.
- Compose the screen from peer regions with explicit ownership: request, workbench, potion readout, route/courier choice, and outcome. Avoid panels stacked inside panels.
- Buttons, ingredient slots, bottle states, route markers, tooltips, and outcome cards must share one authored surface family with hover, focus, selected, disabled, and consequence states.
- No engine-default controls, arbitrary procedural rectangles, universal tiny pixel text, overlapping cards, or stretched ornamental frames.

## Motion system

The shipping slice must include controlled life in four categories:

- ambient: simmer, glass glint, herb sway, courier fidget, village activity;
- interaction: ingredient pickup, drop, stir, pour, select, and route commitment;
- gameplay consequence: mixture visibly changes under heat, chill, shaking, sunlight, or rain;
- transition: workbench to route, route to doorstep, doorstep to evening consequence.

Motion must explain state and causality, not merely decorate a frozen screen.
