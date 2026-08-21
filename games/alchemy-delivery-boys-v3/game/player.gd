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
var _idle_time: float = 0.0
var _brew_time: float = 0.0
var _route_time: float = 0.0
var _deliver_time: float = 0.0
var _choose_time: float = 0.0

@onready var visual: Sprite2D = $Visual
@onready var bottle: Sprite2D = $Bottle


func _ready() -> void:
	visual.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	bottle.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST


func _physics_process(delta: float) -> void:
	var direction := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	velocity = direction * speed
	if direction.length_squared() > 0.0:
		_facing = direction.normalized()
		_walk_phase += delta * 10.0
	move_and_slide()
	_update_nearest_focus()


func _process(delta: float) -> void:
	_idle_time += delta
	_brew_time = maxf(0.0, _brew_time - delta)
	_route_time = maxf(0.0, _route_time - delta)
	_deliver_time = maxf(0.0, _deliver_time - delta)
	_choose_time = maxf(0.0, _choose_time - delta)
	_update_visual()


func _unhandled_input(event: InputEvent) -> void:
	if not event.is_action_pressed("interact"):
		return
	var nearest := _nearest_interactable()
	if nearest != null and nearest.has_method("interact"):
		if nearest.has_method("press_cue"):
			nearest.press_cue()
		nearest.interact(self)
	else:
		get_parent().show_recovery("NO ALCHEMY TARGET IN REACH · MOVE CLOSER")
	get_viewport().set_input_as_handled()


func _nearest_interactable() -> Node2D:
	var nearest: Node2D = null
	var nearest_distance := interaction_radius
	for candidate in get_tree().get_nodes_in_group("interactable"):
		if not candidate is Node2D:
			continue
		if candidate.has_method("is_available") and not candidate.is_available():
			continue
		var target := candidate as Node2D
		var distance := global_position.distance_to(target.global_position)
		if distance <= nearest_distance:
			nearest = target
			nearest_distance = distance
	return nearest


func _update_nearest_focus() -> void:
	var nearest := _nearest_interactable()
	for candidate in get_tree().get_nodes_in_group("interactable"):
		if candidate.has_method("set_focus"):
			candidate.set_focus(candidate == nearest)


func load_potion(mix_id: String, new_warmth: int, new_fizz: int) -> void:
	carrying = true
	source_mix = mix_id
	warmth = new_warmth
	fizz = new_fizz
	route_effect = ""
	delivered_state = ""
	_brew_time = 0.45
	_update_bottle_frame()


func apply_route(effect_id: String) -> bool:
	if not carrying or not route_effect.is_empty():
		return false
	route_effect = effect_id
	if effect_id == "cooling":
		warmth -= 1
	elif effect_id == "venting":
		fizz -= 1
	_route_time = 0.36
	_update_bottle_frame()
	return true


func consume_potion(reaction: String) -> void:
	delivered_state = "%s:w%d:f%d:%s" % [source_mix, warmth, fizz, reaction]
	carrying = false
	_deliver_time = 0.24
	bottle.frame = 3


func play_choose() -> void:
	_choose_time = 0.30


func potion_description() -> String:
	if not carrying:
		return "no bottle"
	var route_text := "unrouted" if route_effect.is_empty() else route_effect
	return "%s | warmth %d, fizz %d | %s" % [source_mix.replace("_", " "), warmth, fizz, route_text]


func bottle_short() -> String:
	if not carrying:
		return "NONE"
	var route_text := "UNROUTED"
	if route_effect == "cooling":
		route_text = "COOLED"
	elif route_effect == "venting":
		route_text = "VENTED"
	return "W%d F%d · %s" % [warmth, fizz, route_text]


func _update_bottle_frame() -> void:
	if route_effect == "venting":
		bottle.frame = 1
	elif route_effect == "cooling":
		bottle.frame = 2
	else:
		bottle.frame = 0


func _update_visual() -> void:
	var frame_index := int(floor(_idle_time * 5.0)) % 4
	visual.flip_h = false
	if velocity.length_squared() > 0.0:
		var step := int(floor(_walk_phase)) % 2
		if absf(_facing.x) > absf(_facing.y):
			frame_index = 6 + step
			visual.flip_h = _facing.x < 0.0
		elif _facing.y < 0.0:
			frame_index = 8 + step
		else:
			frame_index = 4 + step
	elif carrying:
		frame_index = 12 + (int(floor(_idle_time * 3.0)) % 2)
	if _brew_time > 0.0:
		frame_index = 10 if _brew_time > 0.22 else 11
	elif _deliver_time > 0.0:
		frame_index = 14
	elif _choose_time > 0.0:
		frame_index = 15
	visual.frame = frame_index
	visual.position = Vector2(0, -10)
	if _route_time > 0.0:
		visual.position.x = roundi(sin(_route_time * 50.0))
	if carrying:
		_update_bottle_frame()
	bottle.visible = carrying or _deliver_time > 0.0
	var carry_settle := 0.0
	if _brew_time > 0.0:
		carry_settle = clampf(_brew_time / 0.45, 0.0, 1.0) * 6.0
	bottle.position = Vector2(11, -17 + carry_settle).round()
	if _deliver_time > 0.0:
		var progress := 1.0 - (_deliver_time / 0.24)
		bottle.position = Vector2(11 + progress * 12.0, -17 - sin(progress * PI) * 6.0).round()

