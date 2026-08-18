extends Node2D

var factory_mode := "unformed"
var factory_tick_count := 0

func _ready() -> void:
	RenderingServer.set_default_clear_color(Color("#17151f"))
	queue_redraw()

func _draw() -> void:
	var font := ThemeDB.fallback_font
	draw_string(font, Vector2(24, 44), "ALCHEMY DELIVERY BOYS", HORIZONTAL_ALIGNMENT_LEFT, -1, 20, Color("#f2d49b"))
	draw_string(font, Vector2(24, 76), "Fresh project — gameplay proof has not run yet.", HORIZONTAL_ALIGNMENT_LEFT, -1, 14, Color("#d5c7b5"))
	draw_string(font, Vector2(24, 104), "The road is part of the recipe.", HORIZONTAL_ALIGNMENT_LEFT, -1, 14, Color("#83c5be"))

func factory_setup(parameters: Dictionary) -> void:
	factory_mode = str(parameters.get("mode", "unformed"))
	factory_tick_count = 0

func factory_tick(tick: int) -> void:
	factory_tick_count = tick + 1

func factory_sample() -> Dictionary:
	return {"mode": factory_mode, "phase": "unformed", "ticks": factory_tick_count}

func factory_collect() -> Dictionary:
	return {
		"metrics": {
			"first_delivery_complete": 0,
			"meaningful_mix_choices": 0,
			"route_transformation_observed": 0,
			"causal_outcome_observed": 0,
			"villager_consequence_persisted": 0,
			"scenarios_passed": 0,
			"polish_ready": 0,
			"visual_quality": 0
		},
		"violations": []
	}
