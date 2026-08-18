extends Node2D

var elapsed := 0.0

func _ready() -> void:
	queue_redraw()

func _process(delta: float) -> void:
	elapsed += delta
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(0, 0, 480, 270), Color("10131a"))
	draw_rect(Rect2(39, 74, 402, 122), Color("171c26"), true)
	draw_rect(Rect2(39, 74, 402, 122), Color("445066"), false, 2.0)
	draw_string(ThemeDB.fallback_font, Vector2(112, 117), "ALCHEMY DELIVERY BOYS", HORIZONTAL_ALIGNMENT_LEFT, -1, 20, Color("cbd5e1"))
	draw_string(ThemeDB.fallback_font, Vector2(104, 151), "Fresh baseline: no interaction has been approved.", HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color("8290a6"))
	draw_string(ThemeDB.fallback_font, Vector2(159, 177), "BASELINE / NOT A GAME", HORIZONTAL_ALIGNMENT_LEFT, -1, 10, Color("59677d"))

func factory_setup(_parameters: Dictionary) -> void:
	elapsed = 0.0

func factory_tick(_tick: int) -> void:
	pass

func factory_sample() -> Dictionary:
	return {"state":"unformed", "elapsed":elapsed, "interaction_count":0}

func factory_collect() -> Dictionary:
	return {
		"metrics":{"concept_defined":0, "mechanic_proven":0, "meaningful_interactions":0},
		"violations":[]
	}
