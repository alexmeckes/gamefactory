extends Node2D

@export_enum("warm_forward", "fizz_forward") var mix_id: String = "warm_forward"


func _ready() -> void:
	add_to_group("interactable")
	queue_redraw()


func interact(player: CharacterBody2D) -> void:
	var world := get_parent()
	if player.carrying or world.delivery_complete:
		world.show_feedback("Choose ingredients before brewing the next bottle.")
		return
	world.selected_mix = mix_id
	world.show_feedback("Plan set: %s. Reach the cauldron and press E to mix." % mix_id.replace("_", " "))
	world.update_hud(player)
	queue_redraw()


func _draw() -> void:
	var selected: bool = get_parent().selected_mix == mix_id
	var color := Color("ef476f") if mix_id == "warm_forward" else Color("66d9e8")
	if selected:
		draw_circle(Vector2.ZERO, 14.0, Color(color, 0.28))
	draw_rect(Rect2(-9, -8, 18, 16), color.darkened(0.35), true)
	draw_circle(Vector2(0, -9), 7.0, color)
	var label := "WARM" if mix_id == "warm_forward" else "FIZZ"
	draw_string(ThemeDB.fallback_font, Vector2(-13, 18), label, HORIZONTAL_ALIGNMENT_LEFT, -1, 7, Color("fff3c4"))
