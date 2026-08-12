extends Node2D

const ARENA_SIZE := Vector2(960.0, 540.0)
const PLAYER_RADIUS := 15.0
const HAZARD_RADIUS := 17.0
const PICKUP_RADIUS := 11.0
const MAX_HEALTH := 5

var player_position := ARENA_SIZE * 0.5
var player_direction := Vector2.ZERO
var scripted_direction := Vector2.ZERO
var hazard_positions: Array[Vector2] = []
var hazard_velocities: Array[Vector2] = []
var pickup_positions: Array[Vector2] = []
var random := RandomNumberGenerator.new()
var hazard_texture: Texture2D

var player_speed := 230.0
var hazard_speed := 85.0
var hazard_count := 4
var pickup_count := 6
var round_duration := 45.0

var health := MAX_HEALTH
var collected := 0
var elapsed := 0.0
var distance_travelled := 0.0
var hit_cooldown := 0.0
var game_over := false
var factory_mode := false
var playtester_objective := "collector"
var playtester_avoidance_weight := 1.8
var playtester_reaction_ticks := 1

var hud := Label.new()
var help := Label.new()
var banner := Label.new()

func _ready() -> void:
	_bind_controls()
	_load_tuning()
	_load_assets()
	_build_interface()
	_reset_game(1337)

func _load_assets() -> void:
	if ResourceLoader.exists("res://assets/enemies/drone.png"):
		var loaded = load("res://assets/enemies/drone.png")
		if loaded is Texture2D:
			hazard_texture = loaded

func _bind_controls() -> void:
	_add_key("move_left", KEY_A)
	_add_key("move_left", KEY_LEFT)
	_add_key("move_right", KEY_D)
	_add_key("move_right", KEY_RIGHT)
	_add_key("move_up", KEY_W)
	_add_key("move_up", KEY_UP)
	_add_key("move_down", KEY_S)
	_add_key("move_down", KEY_DOWN)

func _add_key(action: StringName, keycode: Key) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)
	var event := InputEventKey.new()
	event.physical_keycode = keycode
	if not InputMap.action_has_event(action, event):
		InputMap.action_add_event(action, event)

func _load_tuning() -> void:
	if not FileAccess.file_exists("res://tuning.json"):
		return
	var parsed = JSON.parse_string(FileAccess.get_file_as_string("res://tuning.json"))
	if not parsed is Dictionary:
		return
	player_speed = float(parsed.get("player_speed", player_speed))
	hazard_speed = float(parsed.get("hazard_speed", hazard_speed))
	hazard_count = maxi(1, int(parsed.get("hazard_count", hazard_count)))
	pickup_count = maxi(1, int(parsed.get("pickup_count", pickup_count)))
	round_duration = maxf(5.0, float(parsed.get("round_duration", round_duration)))

func _build_interface() -> void:
	hud.position = Vector2(18.0, 14.0)
	hud.add_theme_font_size_override("font_size", 20)
	hud.add_theme_color_override("font_color", Color("dcecff"))
	add_child(hud)
	help.position = Vector2(18.0, ARENA_SIZE.y - 36.0)
	help.text = "WASD / arrows to move  |  collect green pulses  |  avoid red drones  |  Enter to restart"
	help.add_theme_font_size_override("font_size", 16)
	help.add_theme_color_override("font_color", Color("87a2bd"))
	add_child(help)
	banner.position = Vector2(0.0, 205.0)
	banner.size = Vector2(ARENA_SIZE.x, 120.0)
	banner.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	banner.add_theme_font_size_override("font_size", 34)
	banner.add_theme_color_override("font_color", Color("ffffff"))
	add_child(banner)

func _reset_game(seed_value: int) -> void:
	random.seed = seed_value
	player_position = ARENA_SIZE * 0.5
	player_direction = Vector2.ZERO
	scripted_direction = Vector2.ZERO
	health = MAX_HEALTH
	collected = 0
	elapsed = 0.0
	distance_travelled = 0.0
	hit_cooldown = 0.0
	game_over = false
	banner.text = ""
	hazard_positions.clear()
	hazard_velocities.clear()
	pickup_positions.clear()
	for index in range(hazard_count):
		var position := _spawn_point(90.0)
		hazard_positions.append(position)
		var angle := random.randf_range(0.0, TAU)
		hazard_velocities.append(Vector2.from_angle(angle) * hazard_speed)
	for index in range(pickup_count):
		pickup_positions.append(_spawn_point(70.0))
	_update_interface()
	queue_redraw()

func _spawn_point(minimum_player_distance: float) -> Vector2:
	for attempt in range(20):
		var point := Vector2(
			random.randf_range(45.0, ARENA_SIZE.x - 45.0),
			random.randf_range(70.0, ARENA_SIZE.y - 60.0)
		)
		if point.distance_to(player_position) >= minimum_player_distance:
			return point
	return Vector2(80.0, 100.0)

func _physics_process(delta: float) -> void:
	if game_over:
		if not factory_mode and Input.is_action_just_pressed("ui_accept"):
			_reset_game(int(Time.get_ticks_msec()))
		return

	var input_direction := scripted_direction if factory_mode else Input.get_vector("move_left", "move_right", "move_up", "move_down")
	if input_direction.length_squared() > 1.0:
		input_direction = input_direction.normalized()
	player_direction = input_direction
	var previous_position := player_position
	player_position += input_direction * player_speed * delta
	player_position.x = clampf(player_position.x, PLAYER_RADIUS + 12.0, ARENA_SIZE.x - PLAYER_RADIUS - 12.0)
	player_position.y = clampf(player_position.y, PLAYER_RADIUS + 52.0, ARENA_SIZE.y - PLAYER_RADIUS - 48.0)
	distance_travelled += previous_position.distance_to(player_position)

	hit_cooldown = maxf(0.0, hit_cooldown - delta)
	_move_hazards(delta)
	_collect_pickups()
	elapsed += delta
	if health <= 0 or elapsed >= round_duration:
		game_over = true
		banner.text = "ROUND COMPLETE\nScore %d  |  Pulses %d\nPress Enter to restart" % [_score(), collected]
	_update_interface()
	queue_redraw()

func _move_hazards(delta: float) -> void:
	for index in range(hazard_positions.size()):
		var position := hazard_positions[index] + hazard_velocities[index] * delta
		var velocity := hazard_velocities[index]
		if position.x < HAZARD_RADIUS or position.x > ARENA_SIZE.x - HAZARD_RADIUS:
			velocity.x *= -1.0
			position.x = clampf(position.x, HAZARD_RADIUS, ARENA_SIZE.x - HAZARD_RADIUS)
		if position.y < 58.0 + HAZARD_RADIUS or position.y > ARENA_SIZE.y - 48.0 - HAZARD_RADIUS:
			velocity.y *= -1.0
			position.y = clampf(position.y, 58.0 + HAZARD_RADIUS, ARENA_SIZE.y - 48.0 - HAZARD_RADIUS)
		hazard_positions[index] = position
		hazard_velocities[index] = velocity
		if hit_cooldown <= 0.0 and position.distance_to(player_position) < PLAYER_RADIUS + HAZARD_RADIUS:
			health -= 1
			hit_cooldown = 0.8
			var push := (player_position - position).normalized()
			if push == Vector2.ZERO:
				push = Vector2.UP
			player_position += push * 28.0

func _collect_pickups() -> void:
	for index in range(pickup_positions.size()):
		if pickup_positions[index].distance_to(player_position) < PLAYER_RADIUS + PICKUP_RADIUS:
			collected += 1
			pickup_positions[index] = _spawn_point(110.0)

func _score() -> int:
	return collected * 100 + health * 25 + int(elapsed * 2.0)

func _scenario_score() -> float:
	var health_ratio := float(health) / float(MAX_HEALTH)
	var collection_score := minf(1.0, float(collected) / 10.0)
	var survival_score := minf(1.0, elapsed / maxf(1.0, round_duration))
	var mobility_score := clampf(distance_travelled / 1500.0, 0.0, 1.0)
	return snappedf(health_ratio * 0.35 + collection_score * 0.35 + survival_score * 0.20 + mobility_score * 0.10, 0.0001)

func _update_interface() -> void:
	hud.text = "PULSE RUNNER    Health %d/%d    Pulses %d    Score %d    Time %.1f" % [health, MAX_HEALTH, collected, _score(), maxf(0.0, round_duration - elapsed)]

func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, ARENA_SIZE), Color("08111f"))
	for x in range(0, int(ARENA_SIZE.x), 48):
		draw_line(Vector2(x, 52.0), Vector2(x, ARENA_SIZE.y - 44.0), Color("10243a"), 1.0)
	for y in range(52, int(ARENA_SIZE.y - 44.0), 48):
		draw_line(Vector2(0.0, y), Vector2(ARENA_SIZE.x, y), Color("10243a"), 1.0)
	draw_line(Vector2(0.0, 52.0), Vector2(ARENA_SIZE.x, 52.0), Color("2b4866"), 2.0)
	draw_line(Vector2(0.0, ARENA_SIZE.y - 44.0), Vector2(ARENA_SIZE.x, ARENA_SIZE.y - 44.0), Color("2b4866"), 2.0)
	for pickup in pickup_positions:
		draw_circle(pickup, PICKUP_RADIUS + 5.0, Color(0.18, 1.0, 0.62, 0.12))
		draw_circle(pickup, PICKUP_RADIUS, Color("39f59c"))
		draw_circle(pickup, 4.0, Color("d4ffe9"))
	for hazard in hazard_positions:
		draw_circle(hazard, HAZARD_RADIUS + 8.0, Color(1.0, 0.2, 0.25, 0.12))
		if hazard_texture:
			draw_texture_rect(hazard_texture, Rect2(hazard - Vector2(25.0, 25.0), Vector2(50.0, 50.0)), false)
		else:
			draw_circle(hazard, HAZARD_RADIUS, Color("f13d52"))
			draw_circle(hazard, 6.0, Color("5d0f20"))
	var player_color := Color("57a8ff") if hit_cooldown <= 0.0 or int(hit_cooldown * 12.0) % 2 == 0 else Color("ffffff")
	draw_circle(player_position, PLAYER_RADIUS + 7.0, Color(0.2, 0.6, 1.0, 0.14))
	draw_circle(player_position, PLAYER_RADIUS, player_color)
	if player_direction != Vector2.ZERO:
		draw_line(player_position, player_position + player_direction * 24.0, Color("ffffff"), 4.0)

func factory_setup(parameters: Dictionary) -> void:
	factory_mode = true
	round_duration = maxf(1.0, float(parameters.get("duration_seconds", 10.0)))
	playtester_objective = str(parameters.get("objective", "collector"))
	playtester_avoidance_weight = maxf(0.0, float(parameters.get("avoidance_weight", 1.8)))
	playtester_reaction_ticks = maxi(1, int(parameters.get("reaction_ticks", 1)))
	_reset_game(int(parameters.get("seed", 7)))

func factory_tick(tick: int) -> void:
	if tick % playtester_reaction_ticks != 0:
		return
	if pickup_positions.is_empty():
		scripted_direction = Vector2.ZERO
		return
	var target := pickup_positions[0]
	var target_distance := target.distance_squared_to(player_position)
	for pickup in pickup_positions:
		var distance := pickup.distance_squared_to(player_position)
		if distance < target_distance:
			target = pickup
			target_distance = distance
	var desired := (target - player_position).normalized()
	var avoidance := Vector2.ZERO
	for hazard in hazard_positions:
		var offset := player_position - hazard
		var distance := offset.length()
		if distance < 110.0 and distance > 0.001:
			avoidance += offset.normalized() * (1.0 - distance / 110.0)
	if playtester_objective == "survivor":
		desired *= 0.35
	elif playtester_objective == "explorer":
		desired = Vector2.from_angle(float(tick) / 38.0)
	scripted_direction = (desired + avoidance * playtester_avoidance_weight).normalized()

func factory_sample() -> Dictionary:
	return {
		"health": health,
		"pickups": collected,
		"score": _score(),
		"player_x": snappedf(player_position.x, 0.01),
		"player_y": snappedf(player_position.y, 0.01)
	}

func factory_collect() -> Dictionary:
	var violations: Array = []
	if health <= 0:
		violations.append({
			"code": "pulse-runner.player-defeated",
			"message": "The deterministic controller was defeated before the scenario ended.",
			"severity": "error"
		})
	return {
		"metrics": {
			"scenario_score": _scenario_score(),
			"fun_score": _scenario_score(),
			"pickups": collected,
			"damage_taken": MAX_HEALTH - health,
			"health_remaining": health,
			"distance_travelled": snappedf(distance_travelled, 0.01),
			"survival_seconds": snappedf(elapsed, 0.001),
			"game_score": _score()
		},
		"violations": violations
	}
