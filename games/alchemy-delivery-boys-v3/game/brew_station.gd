extends Node2D

@export var brew_committed: bool = false
var _pulse: float = 0.0


func _ready() -> void:
	add_to_group("interactable")


func _process(delta: float) -> void:
	_pulse += delta
	queue_redraw()


func interact(player: CharacterBody2D) -> void:
	var world := get_parent()
	if player.carrying:
		world.show_feedback("Your hands are full. Carry this brew through a marked lane.")
		return
	if world.delivery_complete:
		world.show_feedback("Delivery complete. Commit to one next-batch plan below.")
		return
	brew_committed = true
	if world.selected_mix == "warm_forward":
		player.load_potion("warm_forward", 3, 2)
	else:
		player.load_potion("fizz_forward", 2, 3)
	world.on_brew_committed(player)
	queue_redraw()


func _draw() -> void:
	var glow := 0.08 * (sin(_pulse * 3.0) + 1.0)
	draw_circle(Vector2.ZERO, 25.0, Color(0.42, 0.28, 0.58, 0.18 + glow))
	draw_rect(Rect2(-17, -8, 34, 17), Color("2f2740"), true)
	draw_arc(Vector2(0, -8), 17.0, 0.0, PI, 20, Color("b8a1d9"), 3.0)
	draw_circle(Vector2(-7, -11), 2.0 + glow * 8.0, Color("66d9e8"))
	draw_circle(Vector2(4, -14), 1.5 + glow * 6.0, Color("ef476f"))
	draw_string(ThemeDB.fallback_font, Vector2(-27, 23), "BREW [E]", HORIZONTAL_ALIGNMENT_LEFT, -1, 8, Color("fff3c4"))
