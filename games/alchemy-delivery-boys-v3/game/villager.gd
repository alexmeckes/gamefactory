extends Node2D

var reaction: String = "waiting"
var _reaction_time: float = 0.0


func _ready() -> void:
	add_to_group("interactable")


func _process(delta: float) -> void:
	_reaction_time += delta
	queue_redraw()


func interact(player: CharacterBody2D) -> void:
	var world := get_parent()
	if world.delivery_complete:
		world.show_feedback("Mira points to the two follow-up plans. Choose what you learned.")
		return
	if not player.carrying:
		world.show_feedback("Mira still needs a potion. Choose a mix and brew it first.")
		return
	if player.route_effect.is_empty():
		world.show_feedback("The bottle is unfinished: cross COOL or VENT before delivery.")
		return
	reaction = world.resolve_reaction(player.warmth, player.fizz)
	player.consume_potion(reaction)
	world.on_delivery(player, reaction)
	queue_redraw()


func _draw() -> void:
	var bounce := 0.0
	if reaction != "waiting":
		bounce = abs(sin(_reaction_time * 5.0)) * 3.0
	draw_circle(Vector2(0, 8), 9.0, Color("644536"))
	draw_rect(Rect2(-8, -1 - bounce, 16, 20), Color("7f5af0"), true)
	draw_circle(Vector2(0, -8 - bounce), 8.0, Color("d8a47f"))
	var mouth_color := Color("62d2a2") if reaction == "balanced relief" else Color("ff6b6b")
	draw_line(Vector2(-3, -5 - bounce), Vector2(3, -5 - bounce), mouth_color, 1.5)
	draw_string(ThemeDB.fallback_font, Vector2(-22, 31), "MIRA [E]", HORIZONTAL_ALIGNMENT_LEFT, -1, 8, Color("fff3c4"))
