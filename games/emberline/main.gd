extends Node2D

const W := 1152.0
const H := 720.0
const WORK := Color("#110f13")
const PANEL := Color("#211c20")
const INK := Color("#f3e4c2")
const MUTED := Color("#9d8d83")
const EMBER := Color("#ff8a38")
const CYAN := Color("#8de8e2")
const BRASS := Color("#d4a85b")
const DANGER := Color("#d95b4f")

var route := PackedVector2Array([
	Vector2(-25, 278), Vector2(126, 278), Vector2(168, 180), Vector2(318, 180),
	Vector2(358, 382), Vector2(520, 382), Vector2(564, 232), Vector2(712, 232),
	Vector2(754, 444), Vector2(905, 444), Vector2(954, 326), Vector2(1076, 326)
])
var sockets := [
	Vector2(122, 386), Vector2(250, 290), Vector2(337, 108), Vector2(455, 474),
	Vector2(533, 132), Vector2(661, 340), Vector2(731, 144), Vector2(826, 535), Vector2(917, 341)
]
var specs := {
	"spark": {"name":"SPARK", "cost":45, "range":148.0, "rate":0.58, "damage":7.0, "color":Color("#ff9a45"), "mark":"S"},
	"bell": {"name":"COOLING BELL", "cost":50, "range":132.0, "rate":1.05, "damage":2.0, "color":Color("#7adad6"), "mark":"B"},
	"striker": {"name":"STRIKER", "cost":60, "range":116.0, "rate":1.24, "damage":15.0, "color":Color("#e2bd74"), "mark":"I"}
}
var wave_plans := [
	[{"count":7, "hp":28.0, "speed":62.0, "kind":"coal"}],
	[{"count":7, "hp":42.0, "speed":70.0, "kind":"coal"}, {"count":2, "hp":78.0, "speed":43.0, "kind":"iron"}],
	[{"count":9, "hp":54.0, "speed":76.0, "kind":"coal"}, {"count":3, "hp":96.0, "speed":48.0, "kind":"iron"}],
	[{"count":8, "hp":72.0, "speed":80.0, "kind":"coal"}, {"count":1, "hp":330.0, "speed":36.0, "kind":"warden"}]
]

var mode := "title"
var selected_kind := "spark"
var selected_socket := -1
var coins := 145
var core_health := 12
var wave := 0
var wave_active := false
var spawn_queue: Array = []
var spawn_clock := 0.0
var next_wave_clock := 0.0
var towers: Array = []
var enemies: Array = []
var bolts: Array = []
var motes: Array = []
var toast := ""
var toast_clock := 0.0
var factory_mode := false
var enemies_spawned := 0
var enemies_moved := 0.0
var shots_fired := 0
var enemies_defeated := 0
var reactions := 0
var waves_completed := 0
var elapsed := 0.0

func _ready() -> void:
	set_process(true)
	queue_redraw()

func reset_game() -> void:
	mode = "play"
	selected_kind = "spark"
	selected_socket = -1
	coins = 145
	core_health = 12
	wave = 0
	wave_active = false
	spawn_queue.clear()
	enemies.clear()
	towers.clear()
	bolts.clear()
	motes.clear()
	enemies_spawned = 0
	enemies_moved = 0.0
	shots_fired = 0
	enemies_defeated = 0
	reactions = 0
	waves_completed = 0
	elapsed = 0.0
	toast_message("Build beside the fuse, then light the wave.")
	queue_redraw()

func _process(delta: float) -> void:
	if mode != "play":
		queue_redraw()
		return
	elapsed += delta
	if toast_clock > 0.0:
		toast_clock -= delta
	if wave_active:
		spawn_clock -= delta
		if spawn_clock <= 0.0 and not spawn_queue.is_empty():
			spawn_enemy(spawn_queue.pop_front())
			spawn_clock = 0.72 if not factory_mode else 0.24
	update_enemies(delta)
	update_towers(delta)
	update_bolts(delta)
	update_motes(delta)
	if wave_active and spawn_queue.is_empty() and enemies.is_empty():
		wave_active = false
		waves_completed += 1
		coins += 28 + wave * 5
		if wave >= wave_plans.size():
			mode = "victory"
		else:
			toast_message("Wave tempered. Workshop credit +%d" % (28 + wave * 5))
	if factory_mode and mode == "play" and not wave_active and wave < wave_plans.size():
		next_wave_clock -= delta
		if next_wave_clock <= 0.0:
			begin_wave()
			next_wave_clock = 0.55
	queue_redraw()

func begin_wave() -> void:
	if mode != "play" or wave_active or wave >= wave_plans.size():
		return
	spawn_queue.clear()
	for group in wave_plans[wave]:
		for index in range(int(group.count)):
			spawn_queue.append(group.duplicate())
	wave += 1
	wave_active = true
	spawn_clock = 0.05
	selected_socket = -1
	toast_message("Fuse lit — wave %d of %d" % [wave, wave_plans.size()])

func spawn_enemy(plan: Dictionary) -> void:
	var health := float(plan.hp)
	enemies.append({
		"progress": 0.0, "hp": health, "max_hp": health, "speed": float(plan.speed),
		"kind": String(plan.kind), "kindled": 0.0, "chilled": 0.0, "flash": 0.0
	})
	enemies_spawned += 1

func update_enemies(delta: float) -> void:
	for index in range(enemies.size() - 1, -1, -1):
		var enemy: Dictionary = enemies[index]
		enemy.kindled = maxf(0.0, float(enemy.kindled) - delta)
		enemy.chilled = maxf(0.0, float(enemy.chilled) - delta)
		enemy.flash = maxf(0.0, float(enemy.flash) - delta)
		var pace := float(enemy.speed) * (0.58 if float(enemy.chilled) > 0.0 else 1.0)
		enemy.progress += pace * delta
		enemies_moved += pace * delta
		if float(enemy.hp) <= 0.0:
			coins += 9 if enemy.kind != "warden" else 75
			enemies_defeated += 1
			burst(route_position(float(enemy.progress)), EMBER if enemy.kindled > 0.0 else CYAN)
			enemies.remove_at(index)
		elif float(enemy.progress) >= route_length():
			core_health -= 4 if enemy.kind == "warden" else (2 if enemy.kind == "iron" else 1)
			burst(Vector2(1075, 326), DANGER)
			enemies.remove_at(index)
			if core_health <= 0:
				mode = "defeat"

func update_towers(delta: float) -> void:
	for tower in towers:
		tower.cooldown = maxf(0.0, float(tower.cooldown) - delta)
		if float(tower.cooldown) > 0.0:
			continue
		var target := find_target(Vector2(tower.position), float(tower.range))
		if target < 0:
			continue
		var enemy: Dictionary = enemies[target]
		var from := Vector2(tower.position)
		var to := route_position(float(enemy.progress))
		var damage := float(tower.damage)
		var reaction := ""
		match String(tower.kind):
			"spark":
				if float(enemy.chilled) > 0.0:
					damage += 13.0
					reaction = "THERMAL SHOCK"
				enemy.kindled = 2.2
			"bell":
				if float(enemy.kindled) > 0.0:
					damage += 10.0
					reaction = "TEMPER"
				enemy.chilled = 2.7
			"striker":
				if float(enemy.chilled) > 0.0:
					damage += 27.0
					reaction = "SHATTER"
					enemy.chilled = 0.0
		enemy.hp -= damage
		enemy.flash = 0.12
		if not reaction.is_empty():
			reactions += 1
			toast_message(reaction + "  + reaction")
		tower.cooldown = float(tower.rate)
		shots_fired += 1
		bolts.append({"from":from, "to":to, "life":0.15, "color":Color(tower.color), "reaction":not reaction.is_empty()})

func update_bolts(delta: float) -> void:
	for index in range(bolts.size() - 1, -1, -1):
		bolts[index].life -= delta
		if float(bolts[index].life) <= 0.0:
			bolts.remove_at(index)

func update_motes(delta: float) -> void:
	for index in range(motes.size() - 1, -1, -1):
		motes[index].life -= delta
		motes[index].position += Vector2(motes[index].velocity) * delta
		motes[index].velocity *= 0.94
		if float(motes[index].life) <= 0.0:
			motes.remove_at(index)

func find_target(position: Vector2, reach: float) -> int:
	var chosen := -1
	var best := -1.0
	for index in range(enemies.size()):
		var enemy_position := route_position(float(enemies[index].progress))
		if position.distance_to(enemy_position) <= reach and float(enemies[index].progress) > best:
			chosen = index
			best = float(enemies[index].progress)
	return chosen

func place_tower(socket_index: int, kind: String, free := false) -> bool:
	if socket_index < 0 or socket_index >= sockets.size() or socket_occupied(socket_index):
		return false
	var spec: Dictionary = specs[kind]
	if not free and coins < int(spec.cost):
		toast_message("Not enough workshop credit.")
		return false
	if not free:
		coins -= int(spec.cost)
	towers.append({
		"socket":socket_index, "position":sockets[socket_index], "kind":kind, "level":1,
		"range":float(spec.range), "rate":float(spec.rate), "damage":float(spec.damage),
		"cooldown":0.0, "color":Color(spec.color)
	})
	burst(sockets[socket_index], Color(spec.color))
	return true

func upgrade_selected() -> void:
	var tower_index := tower_at_socket(selected_socket)
	if tower_index < 0:
		return
	var tower: Dictionary = towers[tower_index]
	if int(tower.level) >= 3:
		toast_message("Already masterworked.")
		return
	var cost := 32 + int(tower.level) * 16
	if coins < cost:
		toast_message("Upgrade requires %d credit." % cost)
		return
	coins -= cost
	tower.level += 1
	tower.damage *= 1.32
	tower.range += 10.0
	tower.rate *= 0.88
	burst(Vector2(tower.position), INK)

func sell_selected() -> void:
	var tower_index := tower_at_socket(selected_socket)
	if tower_index < 0:
		return
	var tower: Dictionary = towers[tower_index]
	coins += int(specs[String(tower.kind)].cost * 0.65) + (int(tower.level) - 1) * 20
	towers.remove_at(tower_index)
	selected_socket = -1

func socket_occupied(socket_index: int) -> bool:
	return tower_at_socket(socket_index) >= 0

func tower_at_socket(socket_index: int) -> int:
	for index in range(towers.size()):
		if int(towers[index].socket) == socket_index:
			return index
	return -1

func route_length() -> float:
	var total := 0.0
	for index in range(route.size() - 1):
		total += route[index].distance_to(route[index + 1])
	return total

func route_position(progress: float) -> Vector2:
	var remaining := progress
	for index in range(route.size() - 1):
		var segment := route[index].distance_to(route[index + 1])
		if remaining <= segment:
			return route[index].lerp(route[index + 1], remaining / maxf(segment, 0.001))
		remaining -= segment
	return route[-1]

func burst(position: Vector2, color: Color) -> void:
	for index in range(8):
		var angle := TAU * float(index) / 8.0
		motes.append({"position":position, "velocity":Vector2.from_angle(angle) * 42.0, "life":0.55, "color":color})

func toast_message(message: String) -> void:
	toast = message
	toast_clock = 2.4

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		_press(event.position)

func _press(position: Vector2) -> void:
	if mode == "title":
		if Rect2(428, 554, 296, 58).has_point(position):
			reset_game()
		return
	if mode == "victory" or mode == "defeat":
		if Rect2(447, 552, 258, 56).has_point(position):
			reset_game()
		return
	if position.y >= 642.0:
		if Rect2(38, 650, 188, 52).has_point(position): selected_kind = "spark"
		elif Rect2(236, 650, 188, 52).has_point(position): selected_kind = "bell"
		elif Rect2(434, 650, 188, 52).has_point(position): selected_kind = "striker"
		elif Rect2(950, 650, 164, 52).has_point(position): begin_wave()
		return
	if selected_socket >= 0 and Rect2(925, 520, 190, 43).has_point(position):
		upgrade_selected()
		return
	if selected_socket >= 0 and Rect2(925, 573, 190, 37).has_point(position):
		sell_selected()
		return
	for index in range(sockets.size()):
		if sockets[index].distance_to(position) <= 30.0:
			if socket_occupied(index):
				selected_socket = index
			else:
				place_tower(index, selected_kind)
				selected_socket = index
			return
	selected_socket = -1

func _draw() -> void:
	draw_rect(Rect2(0, 0, W, H), WORK)
	draw_workbench()
	if mode == "title": draw_title()
	elif mode == "play": draw_game()
	elif mode == "victory":
		draw_game()
		draw_ending(true)
	else:
		draw_game()
		draw_ending(false)

func draw_workbench() -> void:
	for y in range(0, 640, 64):
		draw_line(Vector2(0, y), Vector2(W, y + 18), Color(0.19, 0.12, 0.10, 0.22), 2.0)
	for x in range(26, 1130, 97):
		draw_circle(Vector2(x, 22 + posmod(x * 3, 590)), 1.5, Color(0.52, 0.35, 0.22, 0.18))

func draw_title() -> void:
	draw_circle(Vector2(576, 296), 172, Color(0.02, 0.02, 0.03, 0.72))
	for ring in range(4):
		draw_arc(Vector2(576, 296), 126.0 + ring * 12.0, -2.6, 0.8, 52, Color(0.93, 0.39 + ring * 0.03, 0.14, 0.28), 5.0)
	draw_string(ThemeDB.fallback_font, Vector2(390, 194), "E M B E R L I N E", HORIZONTAL_ALIGNMENT_LEFT, -1, 39, INK)
	draw_string(ThemeDB.fallback_font, Vector2(427, 230), "A WORKSHOP TOWER DEFENSE", HORIZONTAL_ALIGNMENT_LEFT, -1, 16, BRASS)
	draw_string(ThemeDB.fallback_font, Vector2(405, 432), "TEMPER THE FUSE.  DEFEND THE HEART.", HORIZONTAL_ALIGNMENT_LEFT, -1, 18, MUTED)
	draw_rect(Rect2(428, 554, 296, 58), Color("#8c3c24"), true)
	draw_rect(Rect2(428, 554, 296, 58), BRASS, false, 2.0)
	draw_string(ThemeDB.fallback_font, Vector2(496, 591), "OPEN THE WORKSHOP", HORIZONTAL_ALIGNMENT_LEFT, -1, 18, INK)

func draw_game() -> void:
	draw_rect(Rect2(18, 18, 1116, 604), Color(0.05, 0.045, 0.05, 0.74), true)
	draw_header()
	draw_route()
	draw_sockets_and_towers()
	draw_enemies()
	draw_effects()
	draw_inspector()
	draw_toolbar()
	if toast_clock > 0.0:
		draw_rect(Rect2(374, 79, 404, 34), Color(0.02, 0.02, 0.025, 0.90), true)
		draw_string(ThemeDB.fallback_font, Vector2(396, 102), toast, HORIZONTAL_ALIGNMENT_CENTER, 360, 15, INK)

func draw_header() -> void:
	draw_string(ThemeDB.fallback_font, Vector2(38, 53), "EMBERLINE", HORIZONTAL_ALIGNMENT_LEFT, -1, 25, INK)
	draw_string(ThemeDB.fallback_font, Vector2(218, 51), "WORKSHOP 07", HORIZONTAL_ALIGNMENT_LEFT, -1, 13, MUTED)
	draw_string(ThemeDB.fallback_font, Vector2(769, 50), "CREDIT", HORIZONTAL_ALIGNMENT_LEFT, -1, 12, MUTED)
	draw_string(ThemeDB.fallback_font, Vector2(834, 52), str(coins), HORIZONTAL_ALIGNMENT_LEFT, -1, 21, BRASS)
	draw_string(ThemeDB.fallback_font, Vector2(920, 50), "HEART", HORIZONTAL_ALIGNMENT_LEFT, -1, 12, MUTED)
	for pip in range(12):
		draw_circle(Vector2(980 + pip * 11, 45), 3.5, CYAN if pip < core_health else Color("#392e34"))

func draw_route() -> void:
	for index in range(route.size() - 1):
		draw_line(route[index], route[index + 1], Color("#2e2523"), 22.0, true)
		draw_line(route[index], route[index + 1], Color("#81412a"), 8.0, true)
		draw_line(route[index], route[index + 1], Color("#f17a35"), 2.0, true)
	draw_circle(Vector2(1082, 326), 38, Color("#173b43"))
	draw_circle(Vector2(1082, 326), 24, CYAN, false, 4.0)
	draw_circle(Vector2(1082, 326), 10, Color("#d7ffff"))

func draw_sockets_and_towers() -> void:
	for index in range(sockets.size()):
		var p: Vector2 = sockets[index]
		var occupied := socket_occupied(index)
		draw_circle(p, 25, Color("#17151a"))
		draw_circle(p, 24, BRASS if index == selected_socket else Color("#5d5149"), false, 2.0)
		if not occupied:
			draw_line(p - Vector2(8, 0), p + Vector2(8, 0), Color("#645950"), 2.0)
			draw_line(p - Vector2(0, 8), p + Vector2(0, 8), Color("#645950"), 2.0)
	for tower in towers:
		var p := Vector2(tower.position)
		var color := Color(tower.color)
		if int(tower.socket) == selected_socket:
			draw_circle(p, float(tower.range), Color(color, 0.045))
			draw_arc(p, float(tower.range), 0, TAU, 72, Color(color, 0.26), 1.0)
		draw_circle(p, 20, Color("#282326"))
		draw_circle(p, 16, color, false, 4.0)
		match String(tower.kind):
			"spark":
				draw_line(p + Vector2(-9, 8), p + Vector2(5, -10), color, 5.0)
				draw_circle(p + Vector2(8, -12), 4, EMBER)
			"bell":
				draw_arc(p, 11, PI, TAU, 20, color, 5.0)
				draw_circle(p + Vector2(0, 9), 4, CYAN)
			"striker":
				draw_rect(Rect2(p - Vector2(9, 11), Vector2(18, 19)), color, false, 4.0)
				draw_line(p + Vector2(-12, -13), p + Vector2(12, -13), INK, 4.0)
		for level_mark in range(int(tower.level)):
			draw_circle(p + Vector2(-7 + level_mark * 7, 27), 2, BRASS)

func draw_enemies() -> void:
	for enemy in enemies:
		var p := route_position(float(enemy.progress))
		var radius := 22.0 if enemy.kind == "warden" else (14.0 if enemy.kind == "iron" else 10.0)
		var color := Color("#f7bc67") if enemy.kindled > 0.0 else (Color("#8ee4e2") if enemy.chilled > 0.0 else Color("#78645c"))
		if float(enemy.flash) > 0.0: color = INK
		draw_circle(p + Vector2(3, 4), radius + 2, Color(0,0,0,0.45))
		draw_circle(p, radius, color)
		draw_circle(p, radius, Color("#241c1d"), false, 2.0)
		if enemy.kind == "warden":
			draw_arc(p, radius + 6, -2.8, -0.3, 24, DANGER, 4.0)
		var hp_ratio := clampf(float(enemy.hp) / float(enemy.max_hp), 0.0, 1.0)
		draw_rect(Rect2(p.x - radius, p.y - radius - 10, radius * 2, 3), Color("#301e20"), true)
		draw_rect(Rect2(p.x - radius, p.y - radius - 10, radius * 2 * hp_ratio, 3), CYAN if enemy.chilled > 0.0 else EMBER, true)

func draw_effects() -> void:
	for bolt in bolts:
		draw_line(Vector2(bolt.from), Vector2(bolt.to), Color(bolt.color), 4.0 if bolt.reaction else 2.0, true)
	for mote in motes:
		draw_circle(Vector2(mote.position), 2.5, Color(mote.color, clampf(float(mote.life) * 2.0, 0.0, 1.0)))

func draw_inspector() -> void:
	if selected_socket < 0 or not socket_occupied(selected_socket):
		return
	var tower: Dictionary = towers[tower_at_socket(selected_socket)]
	draw_rect(Rect2(913, 489, 213, 129), Color(0.07, 0.06, 0.07, 0.95), true)
	draw_rect(Rect2(913, 489, 213, 129), Color(tower.color), false, 2.0)
	draw_string(ThemeDB.fallback_font, Vector2(929, 514), "%s  MK %d" % [specs[String(tower.kind)].name, tower.level], HORIZONTAL_ALIGNMENT_LEFT, -1, 15, INK)
	draw_rect(Rect2(925, 520, 190, 43), Color("#3b312b"), true)
	draw_string(ThemeDB.fallback_font, Vector2(948, 547), "MASTERWORK  %d" % (32 + int(tower.level) * 16), HORIZONTAL_ALIGNMENT_LEFT, -1, 14, BRASS)
	draw_rect(Rect2(925, 573, 190, 37), Color("#211b1e"), true)
	draw_string(ThemeDB.fallback_font, Vector2(982, 597), "DISMANTLE", HORIZONTAL_ALIGNMENT_LEFT, -1, 13, MUTED)

func draw_toolbar() -> void:
	draw_rect(Rect2(0, 637, W, 83), Color("#171419"), true)
	var kinds := ["spark", "bell", "striker"]
	for index in range(kinds.size()):
		var kind: String = kinds[index]
		var x := 38.0 + index * 198.0
		var selected := kind == selected_kind
		draw_rect(Rect2(x, 650, 188, 52), Color("#352b29") if selected else Color("#211d21"), true)
		draw_rect(Rect2(x, 650, 188, 52), Color(specs[kind].color) if selected else Color("#4a4140"), false, 2.0)
		draw_circle(Vector2(x + 25, 676), 10, Color(specs[kind].color), false, 3.0)
		draw_string(ThemeDB.fallback_font, Vector2(x + 44, 674), specs[kind].name, HORIZONTAL_ALIGNMENT_LEFT, -1, 14, INK)
		draw_string(ThemeDB.fallback_font, Vector2(x + 44, 693), "%d credit" % specs[kind].cost, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, MUTED)
	draw_string(ThemeDB.fallback_font, Vector2(674, 672), "WAVE %d / %d" % [wave, wave_plans.size()], HORIZONTAL_ALIGNMENT_LEFT, -1, 14, MUTED)
	draw_string(ThemeDB.fallback_font, Vector2(674, 696), "%d reactions" % reactions, HORIZONTAL_ALIGNMENT_LEFT, -1, 13, CYAN)
	draw_rect(Rect2(950, 650, 164, 52), Color("#803821") if not wave_active and wave < wave_plans.size() else Color("#2b2529"), true)
	draw_rect(Rect2(950, 650, 164, 52), BRASS if not wave_active and wave < wave_plans.size() else Color("#4c4242"), false, 2.0)
	draw_string(ThemeDB.fallback_font, Vector2(982, 682), "LIGHT WAVE" if not wave_active else "FUSE BURNING", HORIZONTAL_ALIGNMENT_LEFT, -1, 14, INK if not wave_active else MUTED)

func draw_ending(won: bool) -> void:
	draw_rect(Rect2(0, 0, W, H), Color(0.025, 0.02, 0.025, 0.82), true)
	draw_rect(Rect2(315, 160, 522, 466), Color("#171419"), true)
	draw_rect(Rect2(315, 160, 522, 466), CYAN if won else DANGER, false, 3.0)
	draw_string(ThemeDB.fallback_font, Vector2(415 if won else 432, 257), "HEART TEMPERED" if won else "FUSE BREACHED", HORIZONTAL_ALIGNMENT_LEFT, -1, 36, INK)
	draw_string(ThemeDB.fallback_font, Vector2(435, 310), "%d enemies dismantled" % enemies_defeated, HORIZONTAL_ALIGNMENT_LEFT, -1, 17, MUTED)
	draw_string(ThemeDB.fallback_font, Vector2(435, 345), "%d thermal reactions" % reactions, HORIZONTAL_ALIGNMENT_LEFT, -1, 17, CYAN)
	draw_string(ThemeDB.fallback_font, Vector2(435, 380), "%d / 12 heart integrity" % maxi(core_health, 0), HORIZONTAL_ALIGNMENT_LEFT, -1, 17, BRASS)
	draw_rect(Rect2(447, 552, 258, 56), Color("#813a24"), true)
	draw_string(ThemeDB.fallback_font, Vector2(511, 587), "REOPEN WORKSHOP", HORIZONTAL_ALIGNMENT_LEFT, -1, 16, INK)

func factory_setup(_parameters: Dictionary) -> void:
	factory_mode = true
	reset_game()
	place_tower(1, "spark", true)
	place_tower(3, "bell", true)
	place_tower(5, "striker", true)
	place_tower(7, "spark", true)
	next_wave_clock = 0.05

func factory_tick(tick: int) -> void:
	if tick == 330 and towers.size() < 5:
		place_tower(6, "bell", true)
	if tick == 620 and towers.size() < 6:
		place_tower(8, "striker", true)

func factory_sample() -> Dictionary:
	return {"mode":mode, "wave":wave, "enemies":enemies.size(), "coins":coins, "core_health":core_health, "shots":shots_fired, "reactions":reactions}

func factory_collect() -> Dictionary:
	var violations: Array = []
	if enemies_spawned <= 0: violations.append({"code":"emberline.no_spawn", "message":"No enemies spawned.", "severity":"error"})
	if enemies_moved < 60.0: violations.append({"code":"emberline.no_motion", "message":"Enemies did not traverse the route.", "severity":"error"})
	if shots_fired <= 0: violations.append({"code":"emberline.no_fire", "message":"Towers never fired.", "severity":"error"})
	if reactions <= 0: violations.append({"code":"emberline.no_reaction", "message":"No tower reaction was observed.", "severity":"error"})
	if not is_finite(enemies_moved): violations.append({"code":"emberline.non_finite", "message":"Simulation produced a non-finite value.", "severity":"error"})
	var score := enemies_defeated * 8.0 + reactions * 3.0 + waves_completed * 22.0 + maxi(core_health, 0) * 2.0
	return {"metrics": {"scenario_score":score, "enemies_spawned":enemies_spawned, "enemies_defeated":enemies_defeated, "enemy_distance":enemies_moved, "tower_shots":shots_fired, "reactions":reactions, "waves_completed":waves_completed, "core_health":maxi(core_health, 0), "finite_state":1}, "violations":violations}
