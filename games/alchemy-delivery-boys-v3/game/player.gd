extends CharacterBody2D

@export var speed: float = 90.0
@export var interaction_radius: float = 50.0

var carrying: bool = false
var source_mix: String = ""
var warmth: int = 0
var fizz: int = 0
var route_effect: String = ""
var delivered_state: String = ""
var _facing: Vector2 = Vector2.DOWN
var _walk_phase: float = 0.0


func _physics_process(delta: float) -> void:
	var direction := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	velocity = direction * speed
	if direction.length_squared() > 0.0:
		_facing = direction.normalized()
		_walk_phase += delta * 12.0
	move_and_slide()
	queue_redraw()


func _unhandled_input(event: InputEvent) -> void:
	if not event.is_action_pressed("interact"):
		return
	var nearest: Node2D = null
	var nearest_distance := interaction_radius
	for candidate in get_tree().get_nodes_in_group("interactable"):
		if not candidate is Node2D:
			continue
		if candidate.has_method("is_available") and not candidate.is_available():
			continue
		var target: Node2D = candidate as Node2D
		var distance: float = global_position.distance_to(target.global_position)
		if distance <= nearest_distance:
			nearest = target
			nearest_distance = distance
	if nearest != null and nearest.has_method("interact"):
		nearest.interact(self)
	else:
		get_parent().show_feedback("No alchemy target in reach. Move closer.")
	get_viewport().set_input_as_handled()


func load_potion(mix_id: String, new_warmth: int, new_fizz: int) -> void:
	carrying = true
	source_mix = mix_id
	warmth = new_warmth
	fizz = new_fizz
	route_effect = ""
	delivered_state = ""
	queue_redraw()


func apply_route(effect_id: String) -> bool:
	if not carrying or not route_effect.is_empty():
		return false
	route_effect = effect_id
	if effect_id == "cooling":
		warmth -= 1
	elif effect_id == "venting":
		fizz -= 1
	queue_redraw()
	return true


func consume_potion(reaction: String) -> void:
	delivered_state = "%s:w%d:f%d:%s" % [source_mix, warmth, fizz, reaction]
	carrying = false
	queue_redraw()


func potion_description() -> String:
	if not carrying:
		return "no bottle"
	var route_text := "unrouted" if route_effect.is_empty() else route_effect
	return "%s | warmth %d, fizz %d | %s" % [source_mix.replace("_", " "), warmth, fizz, route_text]


func _draw() -> void:
	var bob := sin(_walk_phase) * 1.2 if velocity.length_squared() > 0.0 else 0.0
	_draw_flat_ellipse(Vector2(0, 7), Vector2(8, 3), Color("3a2f46"))
	draw_circle(Vector2(0, bob), 7.5, Color("f3c969"))
	draw_circle(Vector2(0, -3 + bob), 5.5, Color("ffe7a8"))
	draw_polygon(PackedVector2Array([Vector2(-8, 4 + bob), Vector2(8, 4 + bob), Vector2(5, 13 + bob), Vector2(-5, 13 + bob)]), PackedColorArray([Color("457b9d")]))
	draw_line(Vector2.ZERO, _facing * 7.0, Color("17324d"), 2.0)
	if carrying:
		var bottle_color := Color("ef476f") if warmth > fizz else Color("66d9e8")
		if warmth == fizz:
			bottle_color = Color("9be564")
		draw_rect(Rect2(8, -5 + bob, 7, 10), bottle_color, true)
		draw_rect(Rect2(10, -8 + bob, 3, 3), Color("e9f5db"), true)


func _draw_flat_ellipse(center: Vector2, radii: Vector2, color: Color) -> void:
	var points := PackedVector2Array()
	for index in range(20):
		var angle := TAU * float(index) / 20.0
		points.append(center + Vector2(cos(angle) * radii.x, sin(angle) * radii.y))
	draw_colored_polygon(points, color)
