extends Node2D

class ProbeActor extends Node2D:
	func _draw() -> void:
		draw_circle(Vector2.ZERO, 9.0, Color("65d6ff"))
		draw_circle(Vector2.ZERO, 5.0, Color("16324f"))

class ProbeTarget extends Node2D:
	var activated := false:
		set(value):
			activated = value
			queue_redraw()

	func _draw() -> void:
		draw_rect(Rect2(-12, -12, 24, 24), Color("ffd166") if not activated else Color("80ed99"), true)
		draw_rect(Rect2(-12, -12, 24, 24), Color("563d1b"), false, 3.0)

var player: ProbeActor
var target: ProbeTarget

func _ready() -> void:
	player = ProbeActor.new()
	player.name = "Player"
	player.position = Vector2(40, 90)
	add_child(player)
	target = ProbeTarget.new()
	target.name = "Target"
	target.position = Vector2(205, 90)
	add_child(target)
	queue_redraw()

func _physics_process(delta: float) -> void:
	if Input.is_action_pressed("move_right"):
		player.position.x = minf(player.position.x + 80.0 * delta, 205.0)
	if Input.is_action_just_pressed("interact") and player.position.distance_to(target.position) <= 24.0:
		target.activated = true

func _draw() -> void:
	draw_rect(Rect2(0, 0, 320, 180), Color("10243a"), true)
	draw_line(Vector2(24, 90), Vector2(296, 90), Color("31506f"), 4.0)
