extends Area2D

@export_enum("cooling", "venting") var effect_id: String = "cooling"
var activated: bool = false


func _ready() -> void:
	body_entered.connect(_on_body_entered)


func _on_body_entered(body: Node2D) -> void:
	if not body.has_method("apply_route"):
		return
	if body.apply_route(effect_id):
		activated = true
		get_parent().on_route_applied(body, effect_id)
		queue_redraw()


func _draw() -> void:
	var color := Color("58a6d6") if effect_id == "cooling" else Color("e8a44d")
	draw_rect(Rect2(-11, -20, 22, 40), Color(color, 0.26 if not activated else 0.48), true)
	for offset in [-12, 0, 12]:
		if effect_id == "cooling":
			draw_line(Vector2(-7, offset), Vector2(7, offset), color, 2.0)
		else:
			draw_arc(Vector2(0, offset), 6.0, PI, TAU, 8, color, 2.0)
	var label := "COOL" if effect_id == "cooling" else "VENT"
	draw_string(ThemeDB.fallback_font, Vector2(-15, -25), label, HORIZONTAL_ALIGNMENT_LEFT, -1, 7, Color("fff3c4"))
