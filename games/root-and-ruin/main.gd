extends Node2D

const N := 1
const E := 2
const S := 4
const W := 8
const GRID_COLUMNS := 3
const SLOT_SIZE := Vector2(188.0, 132.0)
const BOARD_ORIGIN := Vector2(72.0, 286.0)
const BATTLE_LIMIT := 18.0

const INK := Color("#090d0d")
const SOIL := Color("#111a17")
const SOIL_LIGHT := Color("#1a2821")
const FRAME := Color("#382f26")
const FRAME_LIGHT := Color("#75654d")
const BONE := Color("#e8dcc0")
const MOSS := Color("#78935b")
const WATER := Color("#34d5df")
const BLIGHT := Color("#e13b91")
const AMBER := Color("#e4ae4e")

var plants: Array[Dictionary] = []
var enemies: Array[Dictionary] = []
var hydrated: Array[bool] = []
var phase := "planning"
var round_index := 0
var battle_time := 0.0
var blight_triggered := false
var spread_clock := 0.0
var result_clock := 0.0
var last_recap := "Rotate roots, then begin the battle."
var events: Array[Dictionary] = []
var flashes: Array[Dictionary] = []
var hover_slot := -1
var selected_plant := 0
var visual_clock := 0.0
var plant_textures: Array[Texture2D] = []
var enemy_textures: Array[Texture2D] = []

var begin_button := Rect2(838.0, 620.0, 268.0, 60.0)
var reset_button := Rect2(858.0, 568.0, 228.0, 34.0)

func _ready() -> void:
	_load_art()
	_initialize_plants()
	_prepare_round(0)
	queue_redraw()

func _load_art() -> void:
	plant_textures = [
		_load_texture("res://assets/generated/bastion-cap/bastion-cap-001.cutout.png"),
		_load_texture("res://assets/generated/dewbell/dewbell-001.cutout.png"),
		_load_texture("res://assets/generated/briar-spitter/briar-spitter-001.cutout.png"),
		_load_texture("res://assets/generated/springheart/springheart-001.cutout.png")
	]
	enemy_textures = [
		_load_texture("res://assets/generated/blightling-round/blightling-round-001.cutout.png"),
		_load_texture("res://assets/generated/blightling-antler/blightling-antler-001.cutout.png"),
		_load_texture("res://assets/generated/blightling-caster/blightling-caster-001.cutout.png")
	]

func _load_texture(path: String) -> Texture2D:
	if ResourceLoader.exists(path): return load(path) as Texture2D
	return null

func _initialize_plants() -> void:
	plants = [
		{"name":"Bastion Cap", "slot":0, "base_ports":E, "rotation":0, "max_hp":74.0, "hp":74.0, "damage":4.5, "period":1.15, "timer":0.2, "color":Color("#b78b55"), "infected":false, "source":false},
		{"name":"Dewbell", "slot":1, "base_ports":S | E | W, "rotation":0, "max_hp":58.0, "hp":58.0, "damage":3.0, "period":0.82, "timer":0.35, "color":Color("#79b7c8"), "infected":false, "source":false},
		{"name":"Briar Spitter", "slot":2, "base_ports":W, "rotation":0, "max_hp":50.0, "hp":50.0, "damage":7.0, "period":1.0, "timer":0.5, "color":Color("#c66a69"), "infected":false, "source":false},
		{"name":"Springheart", "slot":4, "base_ports":N, "rotation":0, "max_hp":100.0, "hp":100.0, "damage":0.0, "period":99.0, "timer":99.0, "color":Color("#65b98a"), "infected":false, "source":true}
	]

func _prepare_round(index: int) -> void:
	round_index = clampi(index, 0, 2)
	phase = "planning"
	battle_time = 0.0
	blight_triggered = false
	spread_clock = 0.0
	result_clock = 0.0
	flashes.clear()
	for plant in plants:
		plant.hp = plant.max_hp
		plant.infected = false
		plant.timer = 0.2 + float(plant.slot) * 0.12
	var base_hp: float = [24.0, 68.0, 82.0][round_index]
	enemies.clear()
	for lane in range(3):
		enemies.append({"lane":lane, "max_hp":base_hp + lane * 4.0, "hp":base_hp + lane * 4.0, "timer":0.9 + lane * 0.18})
	last_recap = [
		"Lesson: connect all three plants to the Springheart.",
		"Blight forecast: LEFT lane. Consider isolating that branch.",
		"Blight forecast: RIGHT lane. Preserve a healthy core."
	][round_index]
	events.append({"type":"round_prepared", "round":round_index + 1, "time":Time.get_ticks_msec()})
	_recompute_hydration()
	queue_redraw()

func _input(event: InputEvent) -> void:
	if event.is_action_pressed("reset_round"):
		_prepare_round(round_index)
		return
	if event.is_action_pressed("start_battle"):
		if phase == "planning": _start_battle()
		elif phase == "won" and round_index < 2: _prepare_round(round_index + 1)
		return
	if event is InputEventMouseMotion:
		hover_slot = _slot_at(event.position)
		queue_redraw()
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		if reset_button.has_point(event.position):
			_prepare_round(round_index)
			return
		if begin_button.has_point(event.position):
			if phase == "planning": _start_battle()
			elif phase == "won" and round_index < 2: _prepare_round(round_index + 1)
			return
		if phase != "planning": return
		var slot := _slot_at(event.position)
		var plant_index := _plant_at_slot(slot)
		if plant_index >= 0 and not plants[plant_index].source:
			selected_plant = plant_index
			plants[plant_index].rotation = (int(plants[plant_index].rotation) + 1) % 4
			events.append({"type":"plant_rotated", "round":round_index + 1, "plant":plants[plant_index].name, "rotation":plants[plant_index].rotation})
			_recompute_hydration()
			queue_redraw()

func _process(delta: float) -> void:
	visual_clock += delta
	if phase == "battle": _simulate(delta)
	for flash in flashes:
		flash.ttl = float(flash.ttl) - delta
	flashes = flashes.filter(func(item: Dictionary) -> bool: return float(item.ttl) > 0.0)
	queue_redraw()

func _start_battle() -> void:
	if phase != "planning": return
	phase = "battle"
	battle_time = 0.0
	last_recap = "The garden fights on its own. Watch water and blight travel."
	events.append({"type":"battle_started", "round":round_index + 1, "rotations":_combat_rotations(), "hydrated":_hydrated_names()})

func _simulate(delta: float) -> void:
	battle_time += delta
	_recompute_hydration()
	var blight_lane: int = [-1, 0, 2][round_index]
	if blight_lane >= 0 and not blight_triggered and battle_time >= 2.0:
		blight_triggered = true
		var victim := _combat_plant_for_lane(blight_lane)
		if victim >= 0 and float(plants[victim].hp) > 0.0:
			plants[victim].infected = true
			flashes.append({"position":_slot_center(plants[victim].slot), "color":Color("#b84f8c"), "ttl":0.7, "radius":58.0})
			events.append({"type":"blight_struck", "round":round_index + 1, "lane":blight_lane, "plant":plants[victim].name, "at":battle_time})
	if blight_triggered:
		spread_clock += delta
		if spread_clock >= 1.0:
			spread_clock -= 1.0
			_blight_pulse()
	_update_plant_actions(delta)
	_update_enemy_actions(delta)
	if enemies.all(func(enemy: Dictionary) -> bool: return float(enemy.hp) <= 0.0):
		_finish_battle(true, "All blightlings were defeated.")
	elif float(plants[3].hp) <= 0.0:
		_finish_battle(false, "Blight reached and ruined the Springheart.")
	elif plants.slice(0, 3).all(func(plant: Dictionary) -> bool: return float(plant.hp) <= 0.0):
		_finish_battle(false, "Every battle-plant withered.")
	elif battle_time >= BATTLE_LIMIT:
		_finish_battle(false, "The garden could not break the assault in time.")

func _update_plant_actions(delta: float) -> void:
	for index in range(3):
		var plant := plants[index]
		if float(plant.hp) <= 0.0: continue
		plant.timer = float(plant.timer) - delta
		if float(plant.timer) > 0.0: continue
		var wet_multiplier := 1.8 if hydrated[index] else 0.24
		var blight_multiplier := 0.62 if plant.infected else 1.0
		var damage: float = float(plant.damage) * wet_multiplier * blight_multiplier
		var target := _first_living_enemy(index)
		if target >= 0:
			enemies[target].hp = maxf(0.0, float(enemies[target].hp) - damage)
			flashes.append({"position":_enemy_center(target), "color":plant.color, "ttl":0.22, "radius":24.0})
		if index == 1 and hydrated[index] and not plant.infected:
			for ally in range(3):
				if hydrated[ally] and float(plants[ally].hp) > 0.0:
					plants[ally].hp = minf(float(plants[ally].max_hp), float(plants[ally].hp) + 1.2)
		plant.timer = float(plant.period)

func _update_enemy_actions(delta: float) -> void:
	for lane in range(enemies.size()):
		var enemy := enemies[lane]
		if float(enemy.hp) <= 0.0: continue
		enemy.timer = float(enemy.timer) - delta
		if float(enemy.timer) > 0.0: continue
		var target := _combat_plant_for_lane(lane)
		if target < 0 or float(plants[target].hp) <= 0.0: target = 3
		var damage := 3.0 + round_index * 0.7
		plants[target].hp = maxf(0.0, float(plants[target].hp) - damage)
		flashes.append({"position":_slot_center(plants[target].slot), "color":Color("#d05a6e"), "ttl":0.18, "radius":20.0})
		enemy.timer = 1.35 + lane * 0.08

func _blight_pulse() -> void:
	var newly_infected: Array[int] = []
	for index in range(plants.size()):
		if not plants[index].infected or float(plants[index].hp) <= 0.0: continue
		for neighbor in _connected_neighbors(index):
			if not plants[neighbor].infected and float(plants[neighbor].hp) > 0.0:
				newly_infected.append(neighbor)
		var pulse_damage := 18.0 if plants[index].source else 11.0
		plants[index].hp = maxf(0.0, float(plants[index].hp) - pulse_damage)
	for index in newly_infected:
		if plants[index].infected: continue
		plants[index].infected = true
		flashes.append({"position":_slot_center(plants[index].slot), "color":Color("#b84f8c"), "ttl":0.55, "radius":46.0})
		events.append({"type":"blight_spread", "round":round_index + 1, "plant":plants[index].name, "at":battle_time})

func _finish_battle(won: bool, reason: String) -> void:
	if phase != "battle": return
	phase = "won" if won else "lost"
	var infected_count := plants.filter(func(plant: Dictionary) -> bool: return bool(plant.infected)).size()
	last_recap = ("VICTORY" if won else "GARDEN LOST") + " · " + reason + " · %d plants infected." % infected_count
	events.append({"type":"battle_finished", "round":round_index + 1, "won":won, "reason":reason, "duration":battle_time, "infected":infected_count, "spring_hp":plants[3].hp})

func _recompute_hydration() -> void:
	hydrated.clear()
	hydrated.resize(plants.size())
	hydrated.fill(false)
	var frontier: Array[int] = [3]
	hydrated[3] = float(plants[3].hp) > 0.0
	while not frontier.is_empty():
		var current: int = frontier.pop_front()
		for neighbor in _connected_neighbors(current):
			if hydrated[neighbor] or float(plants[neighbor].hp) <= 0.0: continue
			hydrated[neighbor] = true
			frontier.append(neighbor)

func _connected_neighbors(plant_index: int) -> Array[int]:
	var result: Array[int] = []
	var slot: int = plants[plant_index].slot
	var row := slot / GRID_COLUMNS
	var column := slot % GRID_COLUMNS
	var ports := _rotated_ports(int(plants[plant_index].base_ports), int(plants[plant_index].rotation))
	var directions := [[N, W, Vector2i(0, -1)], [E, W, Vector2i(1, 0)], [S, N, Vector2i(0, 1)], [W, E, Vector2i(-1, 0)]]
	for direction in directions:
		if (ports & int(direction[0])) == 0: continue
		var next_column: int = column + direction[2].x
		var next_row: int = row + direction[2].y
		if next_column < 0 or next_column >= GRID_COLUMNS or next_row < 0 or next_row >= 2: continue
		var neighbor := _plant_at_slot(next_row * GRID_COLUMNS + next_column)
		if neighbor < 0: continue
		var neighbor_ports := _rotated_ports(int(plants[neighbor].base_ports), int(plants[neighbor].rotation))
		if (neighbor_ports & int(direction[1])) != 0: result.append(neighbor)
	return result

func _rotated_ports(mask: int, rotation: int) -> int:
	var output := mask
	for step in range(rotation % 4):
		var rotated := 0
		if output & N: rotated |= E
		if output & E: rotated |= S
		if output & S: rotated |= W
		if output & W: rotated |= N
		output = rotated
	return output

func _first_living_enemy(preferred: int) -> int:
	if preferred >= 0 and preferred < enemies.size() and float(enemies[preferred].hp) > 0.0: return preferred
	for index in range(enemies.size()):
		if float(enemies[index].hp) > 0.0: return index
	return -1

func _combat_plant_for_lane(lane: int) -> int:
	for index in range(3):
		if int(plants[index].slot) == lane: return index
	return -1

func _plant_at_slot(slot: int) -> int:
	for index in range(plants.size()):
		if int(plants[index].slot) == slot: return index
	return -1

func _slot_at(point: Vector2) -> int:
	for slot in range(6):
		if Rect2(_slot_top_left(slot), SLOT_SIZE).has_point(point): return slot
	return -1

func _slot_top_left(slot: int) -> Vector2:
	return BOARD_ORIGIN + Vector2((slot % GRID_COLUMNS) * (SLOT_SIZE.x + 14.0), (slot / GRID_COLUMNS) * (SLOT_SIZE.y + 14.0))

func _slot_center(slot: int) -> Vector2:
	return _slot_top_left(slot) + SLOT_SIZE * 0.5

func _enemy_center(lane: int) -> Vector2:
	return Vector2(_slot_center(lane).x, 203.0)

func _combat_rotations() -> Array[int]:
	return [int(plants[0].rotation), int(plants[1].rotation), int(plants[2].rotation)]

func _hydrated_names() -> Array[String]:
	var names: Array[String] = []
	for index in range(plants.size()):
		if hydrated[index]: names.append(str(plants[index].name))
	return names

func scenario_configure(round_number: int, rotations: Array[int]) -> void:
	set_process(false)
	for index in range(mini(3, rotations.size())): plants[index].rotation = rotations[index] % 4
	_prepare_round(round_number - 1)

func scenario_run(seconds: float, step := 1.0 / 60.0) -> Dictionary:
	_start_battle()
	var ticks := ceili(seconds / step)
	for tick in range(ticks):
		if phase != "battle": break
		_simulate(step)
	return scenario_snapshot()

func scenario_snapshot() -> Dictionary:
	return {
		"round":round_index + 1,
		"phase":phase,
		"battle_time":battle_time,
		"rotations":_combat_rotations(),
		"hydrated":_hydrated_names(),
		"infected":plants.filter(func(plant: Dictionary) -> bool: return bool(plant.infected)).map(func(plant: Dictionary) -> String: return str(plant.name)),
		"plant_hp":plants.map(func(plant: Dictionary) -> float: return float(plant.hp)),
		"enemy_hp":enemies.map(func(enemy: Dictionary) -> float: return float(enemy.hp)),
		"events":events.duplicate(true),
		"recap":last_recap
	}

func factory_setup(parameters: Dictionary) -> void:
	var round_number := int(parameters.get("round", 2))
	var requested: Array = parameters.get("rotations", [1, 0, 0])
	var rotations: Array[int] = []
	for value in requested: rotations.append(int(value))
	scenario_configure(round_number, rotations)
	_start_battle()

func factory_tick(_tick: int) -> void:
	if phase == "battle": _simulate(1.0 / 60.0)

func factory_sample() -> Dictionary:
	return {
		"round":round_index + 1,
		"phase":phase,
		"battle_time":battle_time,
		"hydrated_count":hydrated.filter(func(value: bool) -> bool: return value).size(),
		"infected_count":plants.filter(func(plant: Dictionary) -> bool: return bool(plant.infected)).size(),
		"spring_hp":plants[3].hp,
		"living_enemies":enemies.filter(func(enemy: Dictionary) -> bool: return float(enemy.hp) > 0.0).size()
	}

func factory_collect() -> Dictionary:
	var infected_count := plants.filter(func(plant: Dictionary) -> bool: return bool(plant.infected)).size()
	var checks := {
		"authored_battle_won":phase == "won",
		"blight_contained":infected_count == 1,
		"healthy_core_preserved":float(plants[3].hp) >= 70.0,
		"two_combatants_remain_hydrated":hydrated[1] and hydrated[2]
	}
	var violations: Array = []
	for check in checks:
		if not checks[check]: violations.append({"code":"root-and-ruin." + str(check).replace("_", "-"), "message":"Scenario contract failed: " + str(check), "severity":"error"})
	return {
		"metrics":{
			"gameplay_contract_score":checks.values().filter(func(value: bool) -> bool: return value).size() * 25,
			"contained_infections":infected_count,
			"spring_health_remaining":plants[3].hp,
			"battle_won":1 if phase == "won" else 0
		},
		"violations":violations
	}

func _draw() -> void:
	draw_rect(Rect2(0, 0, 1152, 720), INK)
	_draw_garden_backdrop()
	_draw_top_bar()
	_draw_panel(Rect2(22, 82, 766, 616), Color("#101814"))
	_label(Vector2(48, 112), "ROOT GARDEN", 13, MOSS)
	_label(Vector2(48, 137), "Turn each plant to route the Springheart's water.", 17, BONE)
	var danger_lane: int = [-1, 0, 2][round_index]
	if danger_lane >= 0:
		var lane_rect := Rect2(_slot_top_left(danger_lane).x, 140, SLOT_SIZE.x, 424)
		draw_rect(lane_rect, Color(0.88, 0.18, 0.36, 0.055))
		draw_line(Vector2(lane_rect.position.x + 4, 144), Vector2(lane_rect.end.x - 4, 144), BLIGHT, 3.0)
	for lane in range(3): _draw_enemy(lane)
	_draw_connections()
	for slot in range(6): _draw_slot(slot)
	for index in range(plants.size()): _draw_plant(index)
	for flash in flashes:
		var alpha: float = clampf(float(flash.ttl) * 1.7, 0.0, 0.65)
		var color: Color = flash.color; color.a = alpha
		draw_circle(flash.position, float(flash.radius) * (1.0 - alpha * 0.25), color, false, 5.0)
	_draw_board_footer()
	_draw_side_panel()

func _draw_garden_backdrop() -> void:
	draw_rect(Rect2(0, 68, 1152, 652), SOIL)
	for index in range(34):
		var x := float((index * 83 + 19) % 1152)
		var y := float(78 + ((index * 137 + 41) % 632))
		var color := Color("#263429") if index % 3 else Color("#303a25")
		draw_circle(Vector2(x, y), float(2 + index % 3), color)
		if index % 4 == 0:
			draw_line(Vector2(x, y), Vector2(x + 5, y - 9), Color("#324c32"), 2.0)
			draw_circle(Vector2(x + 7, y - 10), 3.0, Color("#59653a"))

func _draw_top_bar() -> void:
	draw_rect(Rect2(0, 0, 1152, 68), Color("#121411"))
	draw_rect(Rect2(0, 64, 1152, 4), FRAME)
	draw_rect(Rect2(18, 12, 190, 44), Color("#201c17"))
	draw_rect(Rect2(18, 12, 190, 44), FRAME_LIGHT, false, 2.0)
	_label(Vector2(34, 43), "ROOT & RUIN", 23, BONE)
	_label(Vector2(232, 25), "GROWTH", 10, MOSS)
	for index in range(3):
		var center := Vector2(252 + index * 38, 43)
		draw_circle(center, 11.0, Color("#20251d"))
		draw_circle(center, 8.0, MOSS if index <= round_index else Color("#414039"))
		if index == round_index: draw_arc(center, 14.0, 0, TAU, 16, AMBER, 2.0)
	_draw_status_chip(Rect2(648, 12, 142, 44), "WATER", "%d" % (_hydrated_names().size() * 7), WATER)
	_draw_status_chip(Rect2(796, 12, 142, 44), "BLIGHT", "%d" % (plants.filter(func(p: Dictionary) -> bool: return bool(p.infected)).size() * 9), BLIGHT)
	_draw_status_chip(Rect2(944, 12, 190, 44), "ROUND", "%d / 3" % (round_index + 1), AMBER)

func _draw_status_chip(rect: Rect2, title: String, value: String, accent: Color) -> void:
	draw_rect(rect, Color("#211d18"))
	draw_rect(rect, FRAME_LIGHT, false, 1.0)
	draw_circle(rect.position + Vector2(17, 22), 6.0, accent)
	_label(rect.position + Vector2(30, 18), title, 10, Color("#968d78"))
	_label(rect.position + Vector2(30, 36), value, 16, BONE)

func _draw_panel(rect: Rect2, fill: Color) -> void:
	draw_rect(Rect2(rect.position + Vector2(4, 5), rect.size), Color(0, 0, 0, 0.38))
	draw_rect(rect, fill)
	draw_rect(rect, FRAME, false, 4.0)
	draw_rect(Rect2(rect.position + Vector2(5, 5), rect.size - Vector2(10, 10)), FRAME_LIGHT, false, 1.0)

func _draw_enemy(lane: int) -> void:
	var enemy := enemies[lane]
	var bob: float = roundf(sin(visual_clock * 2.4 + lane * 1.7) * 2.0)
	var center := _enemy_center(lane) + Vector2(0, bob)
	var alive := float(enemy.hp) > 0.0
	_draw_flat_ellipse(center + Vector2(0, 34), Vector2(39, 11), Color(0, 0, 0, 0.46))
	if lane < enemy_textures.size() and enemy_textures[lane] != null and alive:
		var size := Vector2(104, 94)
		_draw_texture_fit(enemy_textures[lane], Rect2(center - Vector2(size.x * 0.5, 58), size))
	else:
		draw_circle(center, 30.0, Color("#63304f") if alive else Color("#29242a"))
		for spike in range(8):
			var direction := Vector2.from_angle(spike * TAU / 8.0)
			draw_line(center + direction * 24, center + direction * 39, Color("#9d356e"), 5.0)
		draw_circle(center + Vector2(-10, -4), 4.0, Color("#ff72bb") if alive else Color("#554b52"))
		draw_circle(center + Vector2(10, -4), 4.0, Color("#ff72bb") if alive else Color("#554b52"))
	var ratio: float = float(enemy.hp) / maxf(1.0, float(enemy.max_hp))
	draw_rect(Rect2(center.x - 40, center.y + 48, 80, 6), Color("#25151f"))
	draw_rect(Rect2(center.x - 39, center.y + 49, 78 * ratio, 4), BLIGHT)
	var danger_lane: int = [-1, 0, 2][round_index]
	if lane == danger_lane and phase == "planning":
		_label(center + Vector2(-33, 76), "STRIKES", 11, Color("#ff755b"))
		draw_colored_polygon(PackedVector2Array([center + Vector2(0, 58), center + Vector2(-6, 66), center + Vector2(6, 66)]), Color("#ff755b"))

func _draw_connections() -> void:
	for index in range(plants.size()):
		for neighbor in _connected_neighbors(index):
			if neighbor < index: continue
			var start := _slot_center(plants[index].slot)
			var finish := _slot_center(plants[neighbor].slot)
			draw_line(start, finish, Color("#20160e"), 22.0, false)
			draw_line(start, finish, Color("#6e4d27"), 14.0, false)
			draw_line(start, finish, Color("#a0773c"), 3.0, false)
			if hydrated[index] and hydrated[neighbor]:
				draw_line(start, finish, WATER, 6.0, false)
				var travel := fmod(visual_clock * 0.65 + index * 0.23, 1.0)
				draw_circle(start.lerp(finish, travel), 6.0, Color("#d4ffff"))
			if plants[index].infected or plants[neighbor].infected:
				draw_line(start, finish, BLIGHT, 7.0, false)
				var corruption := fmod(visual_clock * 0.82 + neighbor * 0.17, 1.0)
				draw_circle(start.lerp(finish, corruption), 7.0, Color("#ff7ac5"))

func _draw_slot(slot: int) -> void:
	var rect := Rect2(_slot_top_left(slot), SLOT_SIZE)
	var plant_index := _plant_at_slot(slot)
	var selected := plant_index == selected_plant and plant_index >= 0
	var fill := Color("#17231d") if slot != hover_slot or phase != "planning" else Color("#21362a")
	draw_rect(Rect2(rect.position + Vector2(3, 4), rect.size), Color(0, 0, 0, 0.4))
	draw_rect(rect, fill)
	draw_rect(rect, AMBER if selected else Color("#455846"), false, 3.0 if selected else 2.0)
	draw_rect(Rect2(rect.position + Vector2(6, 6), rect.size - Vector2(12, 12)), Color("#2c3d31"), false, 1.0)
	for corner in [Vector2(12, 12), Vector2(rect.size.x - 12, 12), Vector2(12, rect.size.y - 12), Vector2(rect.size.x - 12, rect.size.y - 12)]:
		draw_circle(rect.position + corner, 3.0, Color("#6b6e50"))

func _draw_plant(index: int) -> void:
	var plant := plants[index]
	var center := _slot_center(plant.slot)
	var alive := float(plant.hp) > 0.0
	var sprite_size := Vector2(110, 104) if not plant.source else Vector2(116, 108)
	_draw_flat_ellipse(center + Vector2(0, 37), Vector2(48, 13), Color(0, 0, 0, 0.5))
	if index < plant_textures.size() and plant_textures[index] != null and alive:
		_draw_texture_fit(plant_textures[index], Rect2(center - Vector2(sprite_size.x * 0.5, 58), sprite_size))
	else:
		var body_color: Color = plant.color if alive else Color("#343737")
		if plant.source:
			draw_colored_polygon(PackedVector2Array([center + Vector2(0, -44), center + Vector2(32, 4), center + Vector2(0, 42), center + Vector2(-32, 4)]), body_color)
			draw_colored_polygon(PackedVector2Array([center + Vector2(0, -30), center + Vector2(17, 2), center + Vector2(0, 26), center + Vector2(-17, 2)]), Color("#a9fff3"))
		else:
			draw_circle(center + Vector2(0, 6), 28.0, body_color)
			draw_rect(Rect2(center.x - 9, center.y + 16, 18, 26), body_color)
		if index == 0: draw_arc(center + Vector2(0, -4), 34, PI, TAU, 18, Color("#e3c27e"), 9.0)
		if index == 1: draw_circle(center + Vector2(0, -10), 20, Color("#9bdce0"), false, 7.0)
		if index == 2:
			for angle in [-2.7, -2.2, -1.7, -1.2, -0.7, -0.25]: draw_line(center, center + Vector2.from_angle(angle) * 40, Color("#d68582"), 5.0)
	if hydrated[index] and alive: draw_arc(center, 54.0, 0, TAU, 28, WATER, 3.0)
	if plant.infected and alive: draw_arc(center, 58.0, 0, TAU, 20, BLIGHT, 5.0)
	if index == selected_plant and phase == "planning": _draw_selection_corners(center)
	_draw_ports(index, center)
	var ratio: float = float(plant.hp) / maxf(1.0, float(plant.max_hp))
	draw_rect(Rect2(center.x - 51, center.y + 45, 102, 7), Color("#0b100e"))
	draw_rect(Rect2(center.x - 49, center.y + 47, 98 * ratio, 3), Color("#7fb85f"))
	_label(center + Vector2(-70, 66), str(plant.name).to_upper(), 12, BONE)
	if not plant.source and phase == "planning": _draw_rotate_badge(center + Vector2(67, 46), index == selected_plant)

func _draw_selection_corners(center: Vector2) -> void:
	for sx in [-1.0, 1.0]:
		for sy in [-1.0, 1.0]:
			var corner := center + Vector2(72 * sx, 53 * sy)
			draw_line(corner, corner + Vector2(-13 * sx, 0), WATER, 3.0)
			draw_line(corner, corner + Vector2(0, -13 * sy), WATER, 3.0)

func _draw_rotate_badge(center: Vector2, selected: bool) -> void:
	draw_circle(center, 15.0, Color("#26362d"))
	draw_arc(center, 9.0, -2.5, 1.8, 14, WATER if selected else Color("#9aa48b"), 2.0)
	draw_colored_polygon(PackedVector2Array([center + Vector2(7, -7), center + Vector2(13, -6), center + Vector2(10, -1)]), WATER if selected else Color("#9aa48b"))

func _draw_ports(index: int, center: Vector2) -> void:
	var ports := _rotated_ports(int(plants[index].base_ports), int(plants[index].rotation))
	var entries := [[N, Vector2(0, -66)], [E, Vector2(94, 0)], [S, Vector2(0, 66)], [W, Vector2(-94, 0)]]
	for entry in entries:
		if ports & int(entry[0]):
			draw_circle(center + entry[1], 9.0, Color("#3e2e1d"))
			draw_circle(center + entry[1], 5.0, WATER if hydrated[index] else Color("#a9864c"))

func _draw_board_footer() -> void:
	var rect := Rect2(48, 645, 714, 34)
	draw_rect(rect, Color("#1c211a"))
	draw_rect(rect, Color("#4b523c"), false, 1.0)
	var hint := "CLICK A PLANT TO TURN ITS ROOTS" if phase == "planning" else "THE GARDEN FIGHTS AUTOMATICALLY"
	_label(rect.position + Vector2(15, 23), hint, 12, Color("#bfc6a6"))
	_label(rect.position + Vector2(490, 23), "CYAN = WATER", 11, WATER)
	_label(rect.position + Vector2(610, 23), "PINK = BLIGHT", 11, BLIGHT)

func _draw_side_panel() -> void:
	_draw_panel(Rect2(802, 82, 328, 616), Color("#151714"))
	_label(Vector2(826, 110), "GARDENER'S READ", 12, MOSS)
	var phase_text: String = {"planning":"PLANNING", "battle":"BATTLE", "won":"ROUND WON", "lost":"GARDEN LOST"}.get(phase, phase.to_upper())
	_label(Vector2(826, 138), phase_text, 22, BONE)
	var plant := plants[selected_plant]
	var card := Rect2(822, 154, 288, 132)
	draw_rect(card, Color("#20251f"))
	draw_rect(card, Color("#4a5945"), false, 2.0)
	if selected_plant < plant_textures.size() and plant_textures[selected_plant] != null:
		_draw_texture_fit(plant_textures[selected_plant], Rect2(832, 163, 104, 98))
	_label(Vector2(946, 181), str(plant.name).to_upper(), 15, BONE)
	_label(Vector2(946, 202), "ROOTKEEPER" if not plant.source else "THE HEART", 10, MOSS)
	_draw_meter(Rect2(946, 218, 144, 12), float(plant.hp) / float(plant.max_hp), Color("#78af5e"), "VIGOR")
	_draw_meter(Rect2(946, 247, 144, 12), 1.0 if hydrated[selected_plant] else 0.12, WATER, "WATER")
	_label(Vector2(826, 310), "ROOT ORIENTATION", 11, Color("#a99d81"))
	var root_card := Rect2(822, 322, 288, 82)
	draw_rect(root_card, Color("#1c211c"))
	draw_rect(root_card, WATER, false, 2.0)
	_draw_root_diagram(root_card.get_center(), selected_plant)
	_label(Vector2(826, 430), "LANE FORECAST", 11, Color("#a99d81"))
	for lane in range(3): _draw_forecast_card(lane, Rect2(822 + lane * 96, 442, 88, 74))
	var forecast: String = ["No blight pulse", "LEFT lane at 2 seconds", "RIGHT lane at 2 seconds"][round_index]
	_label(Vector2(826, 540), forecast.to_upper(), 12, BLIGHT if round_index > 0 else WATER)
	var action := "BEGIN BATTLE"
	if phase == "won" and round_index < 2: action = "NEXT GROWTH"
	elif phase == "won": action = "RUN COMPLETE"
	elif phase == "lost": action = "RESET TO REPAIR"
	elif phase == "battle": action = "BATTLE RUNNING"
	var enabled := phase == "planning" or (phase == "won" and round_index < 2)
	draw_rect(Rect2(begin_button.position + Vector2(3, 4), begin_button.size), Color(0, 0, 0, 0.5))
	draw_rect(begin_button, Color("#6f5429") if enabled else Color("#30352f"))
	draw_rect(Rect2(begin_button.position + Vector2(4, 4), begin_button.size - Vector2(8, 8)), AMBER if enabled else Color("#596057"), false, 2.0)
	_label(begin_button.position + Vector2(28, 39), action, 20, BONE if enabled else Color("#8e9992"))
	draw_rect(reset_button, Color("#20251f"))
	draw_rect(reset_button, Color("#515a4d"), false, 1.0)
	_label(reset_button.position + Vector2(45, 23), "RESET ROUND  [R]", 12, Color("#aab2a1"))

func _draw_meter(rect: Rect2, ratio: float, color: Color, title: String) -> void:
	_label(rect.position + Vector2(0, -4), title, 9, Color("#918b78"))
	draw_rect(rect, Color("#0b0f0d"))
	draw_rect(Rect2(rect.position + Vector2(2, 2), Vector2((rect.size.x - 4) * clampf(ratio, 0.0, 1.0), rect.size.y - 4)), color)

func _draw_root_diagram(center: Vector2, index: int) -> void:
	var ports := _rotated_ports(int(plants[index].base_ports), int(plants[index].rotation))
	draw_circle(center, 8.0, BONE)
	var entries := [[N, Vector2(0, -25)], [E, Vector2(38, 0)], [S, Vector2(0, 25)], [W, Vector2(-38, 0)]]
	for entry in entries:
		if ports & int(entry[0]):
			draw_line(center, center + entry[1], WATER, 5.0)
			draw_circle(center + entry[1], 7.0, Color("#d4ffff"))
	_label(center + Vector2(66, 5), "TURN %d" % (int(plants[index].rotation) + 1), 11, Color("#bfc6a6"))

func _draw_forecast_card(lane: int, rect: Rect2) -> void:
	var danger_lane: int = [-1, 0, 2][round_index]
	var dangerous := lane == danger_lane
	draw_rect(rect, Color("#261a20") if dangerous else Color("#19211b"))
	draw_rect(rect, BLIGHT if dangerous else Color("#3d5140"), false, 2.0)
	_label(rect.position + Vector2(10, 20), "LANE %d" % (lane + 1), 10, Color("#a89f8c"))
	if dangerous:
		draw_colored_polygon(PackedVector2Array([rect.get_center() + Vector2(0, -5), rect.get_center() + Vector2(-12, 14), rect.get_center() + Vector2(12, 14)]), Color("#ff6b55"))
		_label(rect.position + Vector2(37, 60), "!", 15, INK)
	else:
		draw_line(rect.position + Vector2(29, 50), rect.position + Vector2(39, 60), WATER, 4.0)
		draw_line(rect.position + Vector2(39, 60), rect.position + Vector2(60, 36), WATER, 4.0)

func _draw_flat_ellipse(center: Vector2, radii: Vector2, color: Color) -> void:
	var points := PackedVector2Array()
	for index in range(24):
		var angle := index * TAU / 24.0
		points.append(center + Vector2(cos(angle) * radii.x, sin(angle) * radii.y))
	draw_colored_polygon(points, color)

func _draw_texture_fit(texture: Texture2D, bounds: Rect2) -> void:
	var source_size := texture.get_size()
	if source_size.x <= 0.0 or source_size.y <= 0.0: return
	var fit_scale: float = minf(bounds.size.x / source_size.x, bounds.size.y / source_size.y)
	var fitted := (source_size * fit_scale).floor()
	var position := (bounds.position + (bounds.size - fitted) * 0.5).floor()
	draw_texture_rect(texture, Rect2(position, fitted), false, Color.WHITE)

func _label(position: Vector2, text: String, size: int, color: Color) -> void:
	draw_string(ThemeDB.fallback_font, position, text, HORIZONTAL_ALIGNMENT_LEFT, -1, size, color)

func _draw_wrapped(text: String, position: Vector2, width: float, size: int, color: Color) -> void:
	var words := text.split(" ")
	var line := ""
	var y := position.y
	for word in words:
		var candidate := line + ("" if line.is_empty() else " ") + word
		if ThemeDB.fallback_font.get_string_size(candidate, HORIZONTAL_ALIGNMENT_LEFT, -1, size).x > width and not line.is_empty():
			_label(Vector2(position.x, y), line, size, color)
			y += size + 7
			line = word
		else: line = candidate
	if not line.is_empty(): _label(Vector2(position.x, y), line, size, color)
