extends Node2D

@export_enum("warm_cooling", "fizz_venting") var plan_id: String = "warm_cooling"
var active: bool = false
var selected: bool = false


func _ready() -> void:
	add_to_group("interactable")
	queue_redraw()


func is_available() -> bool:
	return active and not selected


func interact(player: CharacterBody2D) -> void:
	if not active:
		return
	get_parent().commit_follow_up(self, player)
	queue_redraw()


func _draw() -> void:
	if not active:
		return
	var color := Color("9be564") if plan_id == "warm_cooling" else Color("ffc857")
	draw_circle(Vector2.ZERO, 15.0 if selected else 12.0, Color(color, 0.32))
	draw_rect(Rect2(-8, -8, 16, 16), color.darkened(0.35), true)
	draw_line(Vector2(-5, 0), Vector2(5, 0), color, 2.0)
	draw_line(Vector2(0, -5), Vector2(0, 5), color, 2.0)
	var label := "WARM+COOL" if plan_id == "warm_cooling" else "FIZZ+VENT"
	draw_string(ThemeDB.fallback_font, Vector2(-28, 22), label, HORIZONTAL_ALIGNMENT_LEFT, -1, 7, Color("fff3c4"))
