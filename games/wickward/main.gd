extends Node2D

const INK := Color("#171622")
const DEEP := Color("#231f30")
const SLATE := Color("#343040")
const ASH := Color("#4c404f")
const PAPER := Color("#f4e6c1")
const MUTED := Color("#d0b589")
const GOLD := Color("#f7c94c")
const ORANGE := Color("#dc8b30")
const RED := Color("#d9573f")
const BLUE := Color("#4f8bd6")
const VIOLET := Color("#8755a8")
const GREEN := Color("#70a768")

const SLOT_POSITIONS := [Vector2(96, 143), Vector2(174, 137), Vector2(252, 131)]
const SLOT_NAMES := ["REAR", "CENTER", "FRONT"]
const SLOT_BONUSES := ["+50% POWER", "+25% HASTE", "GUARDS ALL"]
const ENEMY_POSITIONS := [Vector2(340, 111), Vector2(393, 149), Vector2(427, 103)]
const BEGIN_RECT := Rect2(360, 231, 108, 26)
const RESET_RECT := Rect2(12, 231, 64, 26)
const BATTLE_LIMIT := 24.0
const PIXEL_FONT := preload("res://assets/fonts/Silkscreen-Regular.ttf")

var guardians: Array[Dictionary] = []
var enemies: Array[Dictionary] = []
var textures: Dictionary = {}
var ui: Dictionary = {}
var particles: Array[Dictionary] = []
var projectiles: Array[Dictionary] = []
var floaters: Array[Dictionary] = []
var phase := "planning"
var selected_slot := -1
var hover_slot := -1
var battle_time := 0.0
var result_time := 0.0
var visual_time := 0.0
var combo := 0
var banner := "Swap two guardians, then light the line."
var events: Array[Dictionary] = []
var intro_time := 0.0
var hit_stop := 0.0
var shake_time := 0.0
var shake_strength := 0.0
var screen_flash := 0.0
var ward_pulse := 0.0
var celebration_clock := 0.0

func _ready() -> void:
	textures = {
		"warden": load("res://assets/runtime/red-warden.png"),
		"seer": load("res://assets/runtime/blue-seer.png"),
		"chime": load("res://assets/runtime/gold-chime.png"),
		"soot": load("res://assets/runtime/soot-moth.png"),
		"needle": load("res://assets/runtime/needle-moth.png"),
		"ash": load("res://assets/runtime/ash-moth.png")
	}
	ui = {
		"flame_crest": load("res://assets/runtime/ui-v2/flame-crest.png"),
		"ward_knot": load("res://assets/runtime/ui-v2/ward-knot.png"),
		"moth_sigil": load("res://assets/runtime/ui-v2/moth-sigil.png"),
		"wax_drip": load("res://assets/runtime/ui-v2/wax-drip.png"),
		"corner_cap": load("res://assets/runtime/ui-v2/corner-cap.png"),
		"rivet": load("res://assets/runtime/ui-v2/rivet.png")
	}
	_reset()
	queue_redraw()

func _reset() -> void:
	phase = "planning"
	selected_slot = -1
	battle_time = 0.0
	result_time = 0.0
	intro_time = 0.0
	hit_stop = 0.0
	shake_time = 0.0
	shake_strength = 0.0
	screen_flash = 0.0
	ward_pulse = 0.0
	celebration_clock = 0.0
	combo = 0
	particles.clear()
	projectiles.clear()
	floaters.clear()
	# Deliberately readable but suboptimal: one swap can solve the formation.
	guardians = [
		{"id":"seer", "name":"BLUE SEER", "max_hp":70.0, "hp":70.0, "power":13.0, "period":1.3, "timer":0.6, "flash":0.0, "hit":0.0, "action":0.0, "action_duration":0.42, "move":0.0, "move_from":SLOT_POSITIONS[0], "down":false},
		{"id":"warden", "name":"RED WARDEN", "max_hp":105.0, "hp":105.0, "power":8.0, "period":1.15, "timer":0.2, "flash":0.0, "hit":0.0, "action":0.0, "action_duration":0.42, "move":0.0, "move_from":SLOT_POSITIONS[1], "down":false},
		{"id":"chime", "name":"GOLD CHIME", "max_hp":62.0, "hp":62.0, "power":5.0, "period":1.65, "timer":0.4, "flash":0.0, "hit":0.0, "action":0.0, "action_duration":0.48, "move":0.0, "move_from":SLOT_POSITIONS[2], "down":false}
	]
	enemies = [
		{"id":"soot", "name":"SOOT MOTH", "max_hp":55.0, "hp":55.0, "power":7.0, "period":1.45, "timer":0.9, "flash":0.0, "hit":0.0, "action":0.0, "action_duration":0.42, "death":0.0},
		{"id":"needle", "name":"NEEDLE MOTH", "max_hp":48.0, "hp":48.0, "power":9.0, "period":1.8, "timer":1.2, "flash":0.0, "hit":0.0, "action":0.0, "action_duration":0.42, "death":0.0},
		{"id":"ash", "name":"ASH MOTH", "max_hp":90.0, "hp":90.0, "power":11.0, "period":2.15, "timer":1.7, "flash":0.0, "hit":0.0, "action":0.0, "action_duration":0.48, "death":0.0}
	]
	banner = "One swap is enough. Who belongs in front?"
	events.append({"type":"reset", "at":Time.get_ticks_msec()})

func _input(event: InputEvent) -> void:
	if event.is_action_pressed("reset_round"):
		_reset()
		queue_redraw()
		return
	if event.is_action_pressed("start_battle"):
		if phase == "planning": _begin()
		elif phase == "won" or phase == "lost": _reset()
		return
	if event is InputEventMouseMotion:
		hover_slot = _slot_at(event.position)
		queue_redraw()
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		if RESET_RECT.has_point(event.position):
			_reset()
			return
		if BEGIN_RECT.has_point(event.position):
			if phase == "planning": _begin()
			elif phase == "won" or phase == "lost": _reset()
			return
		if phase != "planning": return
		var slot := _slot_at(event.position)
		if slot < 0: return
		if selected_slot < 0:
			selected_slot = slot
			banner = "Now choose where %s should move." % guardians[slot].name
		else:
			var from_slot := selected_slot
			var first := guardians[from_slot]
			var second := guardians[slot]
			first.move_from = SLOT_POSITIONS[from_slot]
			second.move_from = SLOT_POSITIONS[slot]
			guardians[from_slot] = second
			guardians[slot] = first
			guardians[from_slot].move = 0.5
			guardians[slot].move = 0.5
			events.append({"type":"formation_swap", "from":selected_slot, "to":slot, "order":_order()})
			selected_slot = -1
			banner = "Formation set. Light the line when ready."
			_burst((SLOT_POSITIONS[from_slot] + SLOT_POSITIONS[slot]) * 0.5 + Vector2(0, -18), GOLD, 10)
		queue_redraw()

func _process(delta: float) -> void:
	_advance(delta)
	queue_redraw()

func _advance(delta: float) -> void:
	visual_time += delta
	screen_flash = maxf(0.0, screen_flash - delta * 3.5)
	ward_pulse = maxf(0.0, ward_pulse - delta * 2.2)
	shake_time = maxf(0.0, shake_time - delta)
	for guardian in guardians:
		guardian.flash = maxf(0.0, float(guardian.flash) - delta)
		guardian.hit = maxf(0.0, float(guardian.hit) - delta)
		guardian.action = maxf(0.0, float(guardian.action) - delta)
		guardian.move = maxf(0.0, float(guardian.move) - delta)
	for enemy in enemies:
		enemy.flash = maxf(0.0, float(enemy.flash) - delta)
		enemy.hit = maxf(0.0, float(enemy.hit) - delta)
		enemy.action = maxf(0.0, float(enemy.action) - delta)
		if float(enemy.death) > 0.0: enemy.death = minf(0.45, float(enemy.death) + delta)
	if phase == "battle":
		if intro_time > 0.0:
			intro_time = maxf(0.0, intro_time - delta)
			if intro_time <= 0.0: banner = "The ward is live — watch each role answer."
		elif hit_stop > 0.0:
			hit_stop = maxf(0.0, hit_stop - delta)
		else:
			_simulate(delta)
	elif phase == "won" or phase == "lost":
		result_time += delta
		if phase == "won" and result_time < 2.4:
			celebration_clock += delta
			if celebration_clock >= 0.09:
				celebration_clock = 0.0
				var x := 142.0 + fmod(result_time * 137.0, 196.0)
				_burst(Vector2(x, 157), GOLD if int(result_time * 10.0) % 2 == 0 else ORANGE, 2)
	for particle in particles:
		particle.ttl = float(particle.ttl) - delta
		particle.position = Vector2(particle.position) + Vector2(particle.velocity) * delta
		particle.velocity = Vector2(particle.velocity) * 0.93
	var arrived: Array[Dictionary] = []
	for projectile in projectiles:
		projectile.t = minf(1.0, float(projectile.t) + delta * float(projectile.speed))
		if float(projectile.t) >= 1.0: arrived.append(projectile)
	for floater in floaters:
		floater.ttl = float(floater.ttl) - delta
		floater.position = Vector2(floater.position) + Vector2(0, -12) * delta
	particles = particles.filter(func(item: Dictionary) -> bool: return float(item.ttl) > 0)
	projectiles = projectiles.filter(func(item: Dictionary) -> bool: return float(item.t) < 1)
	floaters = floaters.filter(func(item: Dictionary) -> bool: return float(item.ttl) > 0)
	for projectile in arrived: _resolve_projectile(projectile)

func _begin() -> void:
	phase = "battle"
	selected_slot = -1
	battle_time = 0.0
	intro_time = 0.85
	banner = "THE WARD IGNITES"
	events.append({"type":"battle_started", "order":_order()})
	_burst(Vector2(176, 132), GOLD, 20)
	screen_flash = 0.55
	ward_pulse = 1.0

func _simulate(delta: float) -> void:
	battle_time += delta
	var haste := 0.75
	for slot in range(guardians.size()):
		var guardian := guardians[slot]
		if guardian.down: continue
		guardian.timer = float(guardian.timer) - delta / (haste if slot == 1 else 1.0)
		if float(guardian.timer) <= 0:
			_guardian_action(slot)
			guardian.timer = float(guardian.period)
	for index in range(enemies.size()):
		var enemy := enemies[index]
		if float(enemy.hp) <= 0: continue
		enemy.timer = float(enemy.timer) - delta
		if float(enemy.timer) <= 0:
			_enemy_action(index)
			enemy.timer = float(enemy.period)
	if enemies.all(func(enemy: Dictionary) -> bool: return float(enemy.hp) <= 0):
		_finish(true)
	elif guardians.all(func(guardian: Dictionary) -> bool: return bool(guardian.down)) or battle_time >= BATTLE_LIMIT:
		_finish(false)

func _guardian_action(slot: int) -> void:
	var guardian := guardians[slot]
	var identifier := String(guardian.id)
	guardian.flash = 0.18
	guardian.action = float(guardian.action_duration)
	if identifier == "chime":
		var target := _lowest_guardian()
		if target >= 0:
			var heal := 11.0 if slot == 1 else 7.0
			banner = "CENTER CHIME rings a mending pulse."
			ward_pulse = 0.75
			_projectile(SLOT_POSITIONS[slot] + Vector2(0, -28), SLOT_POSITIONS[target] + Vector2(0, -13), GOLD, 2.4, {"kind":"heal_guardian", "index":target, "amount":heal})
		return
	var enemy_index := _first_enemy()
	if enemy_index < 0: return
	var damage := float(guardian.power)
	if slot == 0: damage *= 1.5
	if identifier == "seer":
		damage *= 1.12
		banner = "REAR SEER draws deep — the bolt will arc."
		_projectile(SLOT_POSITIONS[slot] + Vector2(17, -28), ENEMY_POSITIONS[enemy_index] + Vector2(-7, -14), BLUE, 2.9, {"kind":"damage_enemy", "index":enemy_index, "amount":damage, "attacker":identifier, "chain":slot == 0})
	else:
		banner = "FRONT WARDEN drives the night back."
		_projectile(SLOT_POSITIONS[slot] + Vector2(16, -14), ENEMY_POSITIONS[enemy_index] + Vector2(-8, -10), RED, 3.8, {"kind":"damage_enemy", "index":enemy_index, "amount":damage, "attacker":identifier, "chain":false})

func _enemy_action(index: int) -> void:
	var target := 2
	while target >= 0 and guardians[target].down: target -= 1
	if target < 0: return
	var damage := float(enemies[index].power)
	var guarded := target == 2
	if guarded: damage *= 0.58
	enemies[index].action = float(enemies[index].action_duration)
	_projectile(ENEMY_POSITIONS[index] + Vector2(-12, -18), SLOT_POSITIONS[target] + Vector2(12, -15), VIOLET, 2.65, {"kind":"damage_guardian", "index":target, "amount":damage, "guarded":guarded})

func _finish(won: bool) -> void:
	if phase != "battle": return
	phase = "won" if won else "lost"
	result_time = 0.0
	projectiles.clear()
	floaters.clear()
	banner = "THE NIGHT BREAKS · Formation held." if won else "THE WARD WENT DARK · Try a sturdier front."
	_burst(Vector2(240, 116), GOLD if won else VIOLET, 34)
	screen_flash = 0.8
	shake_time = 0.35
	shake_strength = 3.0
	events.append({"type":"battle_finished", "won":won, "duration":battle_time, "order":_order(), "survivors":guardians.filter(func(g: Dictionary) -> bool: return not bool(g.down)).size()})

func _first_enemy() -> int:
	for index in range(enemies.size()):
		if float(enemies[index].hp) > 0: return index
	return -1

func _lowest_guardian() -> int:
	var result := -1
	var ratio := 2.0
	for index in range(guardians.size()):
		if guardians[index].down: continue
		var candidate: float = float(guardians[index].hp) / float(guardians[index].max_hp)
		if candidate < ratio:
			ratio = candidate
			result = index
	return result

func _order() -> Array[String]:
	var result: Array[String] = []
	for guardian in guardians: result.append(String(guardian.id))
	return result

func _slot_at(position: Vector2) -> int:
	for index in range(SLOT_POSITIONS.size()):
		if Rect2(SLOT_POSITIONS[index] - Vector2(30, 55), Vector2(60, 73)).has_point(position): return index
	return -1

func _projectile(from: Vector2, to: Vector2, color: Color, speed: float, payload: Dictionary = {}) -> void:
	projectiles.append({"from":from, "to":to, "color":color, "speed":speed, "t":0.0, "payload":payload, "arc":-10.0 - float(projectiles.size() % 3) * 3.0})

func _resolve_projectile(projectile: Dictionary) -> void:
	var payload: Dictionary = projectile.payload
	if payload.is_empty(): return
	var kind := String(payload.get("kind", ""))
	if kind == "damage_enemy":
		var index := int(payload.index)
		if index < 0 or index >= enemies.size() or float(enemies[index].hp) <= 0.0: return
		var damage := float(payload.amount)
		enemies[index].hp = maxf(0.0, float(enemies[index].hp) - damage)
		enemies[index].flash = 0.2
		enemies[index].hit = 0.28
		combo += 1
		_float_text(ENEMY_POSITIONS[index] + Vector2(-10, -42), "%d" % int(damage), PAPER)
		_burst(ENEMY_POSITIONS[index] + Vector2(0, -10), BLUE if String(payload.attacker) == "seer" else RED, 12)
		_impact(2.0, 0.045, 0.38)
		if bool(payload.get("chain", false)):
			var next := _next_enemy(index)
			if next >= 0:
				var chain_damage := maxf(5.0, damage * 0.46)
				_projectile(ENEMY_POSITIONS[index] + Vector2(8, -16), ENEMY_POSITIONS[next] + Vector2(-6, -14), BLUE, 4.8, {"kind":"damage_enemy", "index":next, "amount":chain_damage, "attacker":"seer", "chain":false})
				_float_text(ENEMY_POSITIONS[index] + Vector2(-8, -53), "ARC!", BLUE)
		if float(enemies[index].hp) <= 0.0:
			enemies[index].death = 0.01
			_burst(ENEMY_POSITIONS[index] + Vector2(0, -12), VIOLET, 22)
	elif kind == "heal_guardian":
		var index := int(payload.index)
		if index < 0 or index >= guardians.size() or guardians[index].down: return
		var heal := float(payload.amount)
		guardians[index].hp = minf(float(guardians[index].max_hp), float(guardians[index].hp) + heal)
		guardians[index].flash = 0.22
		_float_text(SLOT_POSITIONS[index] + Vector2(-8, -42), "+%d" % int(heal), GREEN)
		_burst(SLOT_POSITIONS[index] + Vector2(0, -8), GOLD, 12)
		ward_pulse = 1.0
	elif kind == "damage_guardian":
		var index := int(payload.index)
		if index < 0 or index >= guardians.size() or guardians[index].down: return
		var damage := float(payload.amount)
		guardians[index].hp = maxf(0.0, float(guardians[index].hp) - damage)
		guardians[index].flash = 0.24
		guardians[index].hit = 0.3
		_float_text(SLOT_POSITIONS[index] + Vector2(-8, -43), "BLOCK %d" % int(damage) if bool(payload.get("guarded", false)) else "-%d" % int(damage), GOLD if bool(payload.get("guarded", false)) else RED)
		_burst(SLOT_POSITIONS[index] + Vector2(0, -10), GOLD if bool(payload.get("guarded", false)) else VIOLET, 11)
		ward_pulse = 1.0 if bool(payload.get("guarded", false)) else 0.35
		_impact(2.4, 0.055, 0.46)
		if float(guardians[index].hp) <= 0.0:
			guardians[index].down = true
			banner = "%s was snuffed out." % guardians[index].name

func _next_enemy(after: int) -> int:
	for offset in range(1, enemies.size() + 1):
		var index := (after + offset) % enemies.size()
		if float(enemies[index].hp) > 0.0: return index
	return -1

func _impact(strength: float, freeze: float, flash: float) -> void:
	shake_strength = maxf(shake_strength, strength)
	shake_time = maxf(shake_time, 0.16)
	hit_stop = maxf(hit_stop, freeze)
	screen_flash = maxf(screen_flash, flash)

func _burst(position: Vector2, color: Color, count: int) -> void:
	for index in range(count):
		var angle := float(index) / maxf(1.0, float(count)) * TAU + visual_time
		var speed := 12.0 + float((index * 7) % 19)
		particles.append({"position":position, "velocity":Vector2(cos(angle), sin(angle)) * speed, "color":color, "ttl":0.35 + float(index % 4) * 0.08})

func _float_text(position: Vector2, value: String, color: Color) -> void:
	floaters.append({"position":position, "text":value, "color":color, "ttl":0.75})

func _draw() -> void:
	_draw_background()
	_draw_header()
	var shake := Vector2.ZERO
	if shake_time > 0.0:
		shake = Vector2(round(sin(visual_time * 97.0) * shake_strength), round(cos(visual_time * 73.0) * shake_strength * 0.55))
	draw_set_transform(shake)
	_draw_board()
	_draw_formation_magic()
	_draw_units()
	_draw_effects()
	draw_set_transform(Vector2.ZERO)
	if screen_flash > 0.0:
		draw_rect(Rect2(0, 35, 480, 187), Color(PAPER, minf(0.22, screen_flash * 0.18)))
	_draw_footer()
	if phase == "won" or phase == "lost": _draw_result()

func _draw_background() -> void:
	draw_rect(Rect2(0, 0, 480, 270), INK)
	for y in range(0, 270, 8):
		for x in range(0, 480, 8):
			if (x / 8 + y / 8) as int % 2 == 0: draw_rect(Rect2(x, y, 8, 8), Color("#1b1926"))
	for x in range(0, 480, 16): draw_line(Vector2(x, 36), Vector2(x - 46, 222), Color("#282235"), 1)

func _draw_header() -> void:
	draw_rect(Rect2(0, 0, 480, 35), DEEP)
	draw_rect(Rect2(0, 33, 480, 2), GOLD)
	draw_string(PIXEL_FONT, Vector2(13, 24), "WICKWARD", HORIZONTAL_ALIGNMENT_LEFT, -1, 20, PAPER)
	draw_string(PIXEL_FONT, Vector2(130, 21), "ONE SWAP · THREE CONSEQUENCES", HORIZONTAL_ALIGNMENT_LEFT, -1, 8, MUTED)
	var defeated := enemies.filter(func(enemy: Dictionary) -> bool: return float(enemy.hp) <= 0.0).size()
	for index in range(3): _draw_pip(Vector2(432 + index * 16, 17), GOLD if index < defeated else ASH, index < defeated)

func _draw_pip(center: Vector2, color: Color, lit: bool) -> void:
	var rect := Rect2(center - Vector2(6, 6), Vector2(12, 12))
	draw_rect(rect, INK)
	draw_rect(rect, MUTED if lit else SLATE, false, 1.0)
	if lit:
		var rise: float = round(sin(visual_time * 9.0 + center.x))
		draw_colored_polygon(PackedVector2Array([center + Vector2(-3, 3), center + Vector2(0, -4 + rise), center + Vector2(3, 3)]), color)
		draw_rect(Rect2(center + Vector2(-1, 0), Vector2(2, 3)), PAPER)
	else:
		draw_texture(ui.rivet, center - Vector2(2, 2), Color(0.55, 0.5, 0.62, 0.7))

func _draw_board() -> void:
	var board := Rect2(12, 44, 456, 176)
	_draw_panel(board, ASH, Color("#12101b"), true)
	for x in range(24, 458, 16):
		for y in range(55, 215, 16):
			if ((x + y) / 16) as int % 3 == 0: draw_rect(Rect2(x, y, 2, 2), SLATE)
	draw_line(Vector2(292, 54), Vector2(292, 210), ASH, 1)
	draw_texture(ui.flame_crest, Vector2(20, 48))
	draw_string(PIXEL_FONT, Vector2(51, 65), "YOUR WARD", HORIZONTAL_ALIGNMENT_LEFT, -1, 8, MUTED)
	draw_texture(ui.moth_sigil, Vector2(303, 50))
	draw_string(PIXEL_FONT, Vector2(332, 65), "THE NIGHT", HORIZONTAL_ALIGNMENT_LEFT, -1, 8, MUTED)
	draw_texture(ui.ward_knot, Vector2(280, 47), Color(1, 1, 1, 0.82))
	# Formation rail and unmistakable rear-to-front direction.
	draw_line(Vector2(75, 174), Vector2(270, 158), SLATE, 3)
	draw_line(Vector2(75, 173), Vector2(270, 157), MUTED, 1)
	draw_colored_polygon(PackedVector2Array([Vector2(270, 157), Vector2(260, 152), Vector2(261, 163)]), MUTED)
	for index in range(3):
		var center: Vector2 = SLOT_POSITIONS[index]
		var selected := selected_slot == index
		var hovered := hover_slot == index and phase == "planning"
		var border := GOLD if selected else (PAPER if hovered else ASH)
		var socket_center := center + Vector2(0, -16)
		draw_circle(socket_center, 29, Color(DEEP, 0.9))
		draw_arc(socket_center, 29, 0, TAU, 32, border, 2.0 if selected else 1.0)
		draw_arc(socket_center, 25, 0, TAU, 32, Color(border, 0.22), 1.0)
		if selected:
			for point in [Vector2(-31, 0), Vector2(31, 0), Vector2(0, -31), Vector2(0, 31)]: draw_texture(ui.rivet, socket_center + point - Vector2(2, 2))
		draw_string(PIXEL_FONT, center + Vector2(-27, 42), SLOT_NAMES[index], HORIZONTAL_ALIGNMENT_CENTER, 54, 8, border)
		draw_string(PIXEL_FONT, center + Vector2(-35, 52), SLOT_BONUSES[index], HORIZONTAL_ALIGNMENT_CENTER, 70, 6, MUTED)

func _draw_formation_magic() -> void:
	if phase == "planning":
		if selected_slot >= 0:
			var selected_center: Vector2 = SLOT_POSITIONS[selected_slot]
			for ring in range(3):
				var radius := 25.0 + float(ring) * 5.0 + sin(visual_time * 5.0 + ring) * 1.5
				draw_arc(selected_center + Vector2(0, -16), radius, -PI, 0.0, 18, Color(GOLD, 0.26 - ring * 0.06), 1.0)
		return
	if phase != "battle": return
	var linked := _order() == ["seer", "chime", "warden"]
	var pulse := 0.55 + sin(visual_time * 7.0) * 0.18 + ward_pulse * 0.35
	for index in range(guardians.size() - 1):
		var from: Vector2 = SLOT_POSITIONS[index] + Vector2(21, -13)
		var to: Vector2 = SLOT_POSITIONS[index + 1] + Vector2(-21, -13)
		draw_line(from, to, Color(GOLD if linked else MUTED, pulse * (0.75 if linked else 0.35)), 3.0 if ward_pulse > 0.5 else 1.0)
		for mote in range(2):
			var travel := fmod(visual_time * (0.85 + mote * 0.25) + index * 0.21 + mote * 0.43, 1.0)
			var at: Vector2 = from.lerp(to, travel)
			draw_rect(Rect2(round(at.x), round(at.y), 2, 2), GOLD if linked else MUTED)
	if linked:
		var shield_center := SLOT_POSITIONS[2] + Vector2(4, -18)
		draw_arc(shield_center, 32.0 + sin(visual_time * 6.0) * 1.5, -PI * 0.63, PI * 0.63, 20, Color(GOLD, 0.32 + ward_pulse * 0.35), 2.0)
	if intro_time > 0.0:
		var progress := 1.0 - intro_time / 0.85
		for ring in range(4):
			var radius := progress * (44.0 + ring * 24.0)
			draw_arc(Vector2(176, 124), radius, 0.0, TAU, 36, Color(GOLD, maxf(0.0, 0.45 - progress * 0.35 - ring * 0.05)), 2.0)

func _draw_units() -> void:
	for index in range(guardians.size()):
		var guardian := guardians[index]
		var position: Vector2 = _guardian_position(index, guardian)
		var bob: float = round(sin(visual_time * (3.4 + index * 0.3) + index) * (1.0 if phase == "planning" else 1.8))
		var pose := _action_pose(guardian, 1.0)
		var offset: Vector2 = pose.offset
		var scale: Vector2 = pose.scale
		if float(guardian.hit) > 0.0:
			offset.x -= round(sin(float(guardian.hit) * 95.0) * 4.0)
			scale = Vector2(1.08, 0.92)
		if guardian.down:
			offset.y += 9.0
			scale = Vector2(1.12, 0.68)
		var tint := Color.WHITE
		if guardian.down: tint = Color(0.35, 0.32, 0.4, 0.62)
		elif float(guardian.flash) > 0: tint = PAPER
		_draw_shadow(position + Vector2(offset.x * 0.25, 5), 21.0 * scale.x, Color(INK, 0.48))
		_draw_scaled_texture(textures[String(guardian.id)], position + Vector2(0, bob) + offset, scale, tint)
		_draw_flame_glow(position + Vector2(offset.x * 0.2, -46 + bob + offset.y), String(guardian.id))
		if phase == "planning" and (selected_slot == index or hover_slot == index):
			var ring_color := GOLD if selected_slot == index else PAPER
			draw_arc(position + Vector2(0, -16), 32, 0, TAU, 32, ring_color, 2.0)
		_draw_health(position + Vector2(-25, 18), 50, float(guardian.hp), float(guardian.max_hp), GREEN)
	for index in range(enemies.size()):
		var enemy := enemies[index]
		if float(enemy.hp) <= 0 and float(enemy.death) >= 0.45: continue
		var position: Vector2 = ENEMY_POSITIONS[index]
		var bob: float = round(sin(visual_time * (4.0 + index * 0.35) + index * 1.7) * 3.0)
		var pose := _action_pose(enemy, -1.0)
		var offset: Vector2 = pose.offset
		var scale: Vector2 = pose.scale
		if float(enemy.hit) > 0.0:
			offset.x += round(sin(float(enemy.hit) * 105.0) * 5.0)
			scale = Vector2(1.12, 0.86)
		if float(enemy.hp) <= 0.0:
			var vanish := clampf(float(enemy.death) / 0.45, 0.0, 1.0)
			offset.y -= vanish * 8.0
			scale = Vector2(1.0 + vanish * 0.35, 1.0 - vanish * 0.82)
		var tint := PAPER if float(enemy.flash) > 0 else Color.WHITE
		if float(enemy.hp) <= 0.0: tint.a = maxf(0.0, 1.0 - float(enemy.death) / 0.45)
		_draw_shadow(position + Vector2(offset.x * 0.2, 7), 18.0 * scale.x, Color(INK, 0.42 * tint.a))
		_draw_scaled_texture(textures[String(enemy.id)], position + Vector2(0, bob) + offset, scale, tint)
		if float(enemy.hp) > 0.0: _draw_health(position + Vector2(-21, 17), 42, float(enemy.hp), float(enemy.max_hp), VIOLET)

func _guardian_position(index: int, guardian: Dictionary) -> Vector2:
	var target: Vector2 = SLOT_POSITIONS[index]
	if float(guardian.move) <= 0.0: return target
	var progress := clampf(1.0 - float(guardian.move) / 0.5, 0.0, 1.0)
	var eased := smoothstep(0.0, 1.0, progress)
	return Vector2(guardian.move_from).lerp(target, eased) + Vector2(0, -sin(progress * PI) * 17.0)

func _action_pose(unit: Dictionary, direction: float) -> Dictionary:
	var remaining := float(unit.action)
	if remaining <= 0.0: return {"offset":Vector2.ZERO, "scale":Vector2.ONE}
	var duration := float(unit.action_duration)
	var progress := clampf(1.0 - remaining / duration, 0.0, 1.0)
	var travel := 0.0
	var scale := Vector2.ONE
	if progress < 0.24:
		travel = lerpf(0.0, -5.0, progress / 0.24)
		scale = Vector2(1.08, 0.9)
	elif progress < 0.56:
		travel = lerpf(-5.0, 13.0, (progress - 0.24) / 0.32)
		scale = Vector2(0.9, 1.13)
	else:
		travel = lerpf(13.0, 0.0, (progress - 0.56) / 0.44)
		scale = Vector2(1.0, 1.0)
	return {"offset":Vector2(round(travel * direction), 0), "scale":scale}

func _draw_scaled_texture(texture: Texture2D, anchor: Vector2, scale: Vector2, tint: Color) -> void:
	var size := Vector2(64.0 * scale.x, 64.0 * scale.y)
	draw_texture_rect(texture, Rect2(round(anchor.x - size.x * 0.5), round(anchor.y - 58.0 + (64.0 - size.y)), round(size.x), round(size.y)), false, tint)

func _draw_shadow(position: Vector2, radius: float, color: Color) -> void:
	var points := PackedVector2Array()
	for point in range(16):
		var angle := float(point) / 16.0 * TAU
		points.append(position + Vector2(cos(angle) * radius, sin(angle) * radius * 0.28))
	draw_colored_polygon(points, color)

func _draw_flame_glow(position: Vector2, identifier: String) -> void:
	if phase == "lost": return
	var color := BLUE if identifier == "seer" else (RED if identifier == "warden" else GOLD)
	var pulse := 3.0 + sin(visual_time * 11.0 + position.x) * 0.8
	draw_circle(Vector2(round(position.x), round(position.y)), pulse + 3.0, Color(color, 0.08))
	draw_circle(Vector2(round(position.x), round(position.y)), pulse, Color(color, 0.16))

func _draw_health(position: Vector2, width: float, value: float, maximum: float, color: Color) -> void:
	var outer := Rect2(round(position.x), round(position.y), round(width), 7)
	draw_rect(outer, INK)
	draw_rect(outer, ASH, false, 1.0)
	draw_rect(Rect2(outer.position + Vector2(2, 2), Vector2(round((width - 4) * clampf(value / maximum, 0, 1)), 3)), color)

func _draw_effects() -> void:
	for projectile in projectiles:
		var progress := ease(float(projectile.t), -0.7)
		for trail in range(4, -1, -1):
			var trail_t := maxf(0.0, progress - float(trail) * 0.035)
			var at := _projectile_position(projectile, trail_t)
			var alpha := 1.0 - float(trail) * 0.17
			var size := 5.0 if trail == 0 else 2.0
			draw_rect(Rect2(round(at.x - size * 0.5), round(at.y - size * 0.5), size, size), Color(projectile.color, alpha))
		var head := _projectile_position(projectile, progress)
		draw_rect(Rect2(round(head.x), round(head.y), 2, 2), PAPER)
	for particle in particles:
		var position: Vector2 = particle.position
		draw_rect(Rect2(round(position.x), round(position.y), 2, 2), particle.color)
	for floater in floaters:
		draw_string(PIXEL_FONT, floater.position, floater.text, HORIZONTAL_ALIGNMENT_CENTER, 30, 8, floater.color)

func _projectile_position(projectile: Dictionary, progress: float) -> Vector2:
	var from := Vector2(projectile.from)
	var to := Vector2(projectile.to)
	var straight := from.lerp(to, progress)
	return straight + Vector2(0, sin(progress * PI) * float(projectile.arc))

func _draw_footer() -> void:
	draw_rect(Rect2(0, 222, 480, 48), DEEP)
	draw_line(Vector2(0, 222), Vector2(480, 222), ASH, 1)
	_draw_button(RESET_RECT, "RESET [R]", false)
	draw_string(PIXEL_FONT, Vector2(84, 247), banner, HORIZONTAL_ALIGNMENT_LEFT, 266, 7, PAPER)
	var action := "LIGHT THE LINE" if phase == "planning" else ("AGAIN" if phase == "won" or phase == "lost" else "BURNING...")
	_draw_button(BEGIN_RECT, action, phase == "planning" or phase == "won" or phase == "lost")

func _draw_button(rect: Rect2, label: String, active: bool) -> void:
	var border := GOLD if active else ASH
	var fill := Color("#8e3632") if active else INK
	_draw_panel(rect, border, fill, false)
	if active:
		draw_rect(Rect2(rect.position + Vector2(4, 4), Vector2(rect.size.x - 8, 2)), Color(RED, 0.75))
		draw_texture(ui.wax_drip, Vector2(round(rect.position.x + rect.size.x * 0.5 - 16), rect.position.y + 2), Color(1, 1, 1, 0.8))
	draw_string(PIXEL_FONT, rect.position + Vector2(0, 17), label, HORIZONTAL_ALIGNMENT_CENTER, rect.size.x, 7, PAPER if active else MUTED)

func _draw_panel(rect: Rect2, border: Color, fill: Color, ornament: bool) -> void:
	var snapped := Rect2(round(rect.position.x), round(rect.position.y), round(rect.size.x), round(rect.size.y))
	draw_rect(snapped, fill)
	draw_rect(snapped, border, false, 2.0)
	if snapped.size.x < 16 or snapped.size.y < 16: return
	draw_rect(Rect2(snapped.position + Vector2(4, 4), snapped.size - Vector2(8, 8)), Color(border, 0.22), false, 1.0)
	for point in [
		snapped.position + Vector2(2, 2),
		Vector2(snapped.end.x - 7, snapped.position.y + 2),
		Vector2(snapped.position.x + 2, snapped.end.y - 7),
		snapped.end - Vector2(7, 7)
	]: draw_texture(ui.corner_cap, point, Color.WHITE)
	if ornament and snapped.size.x >= 64:
		draw_texture(ui.wax_drip, Vector2(round(snapped.position.x + snapped.size.x * 0.5 - 16), snapped.position.y + 2), Color(1, 1, 1, 0.68))

func _draw_result() -> void:
	var reveal := clampf(result_time / 0.38, 0.0, 1.0)
	var overshoot := 1.0 + sin(reveal * PI) * 0.08
	var panel_size := Vector2(216, 91) * reveal * overshoot
	var panel := Rect2(Vector2(240, 114.5) - panel_size * 0.5, panel_size)
	draw_rect(Rect2(0, 35, 480, 187), Color(INK, 0.62 * reveal))
	if phase == "won":
		for ray in range(18):
			var angle := float(ray) / 18.0 * TAU + visual_time * 0.08
			var inner := Vector2(240, 112) + Vector2(cos(angle), sin(angle)) * 54.0
			var outer := Vector2(240, 112) + Vector2(cos(angle), sin(angle)) * (82.0 + sin(visual_time * 3.0 + ray) * 5.0)
			draw_line(inner, outer, Color(GOLD, 0.14 * reveal), 2.0)
	_draw_panel(panel, Color(GOLD, reveal) if phase == "won" else Color(VIOLET, reveal), Color(DEEP, reveal), true)
	if reveal > 0.82:
		draw_texture(ui.flame_crest, Vector2(226, 54), Color(1, 1, 1, clampf((reveal - 0.82) / 0.18, 0.0, 1.0)))
	if reveal < 0.7: return
	var title := "THE NIGHT BREAKS" if phase == "won" else "THE WARD WENT DARK"
	var text_alpha := clampf((reveal - 0.7) / 0.3, 0.0, 1.0)
	draw_string(PIXEL_FONT, Vector2(136, 101), title, HORIZONTAL_ALIGNMENT_CENTER, 208, 14, Color(PAPER, text_alpha))
	var detail := "%d HIT COMBO · %.1fs" % [combo, battle_time]
	draw_string(PIXEL_FONT, Vector2(136, 121), detail, HORIZONTAL_ALIGNMENT_CENTER, 208, 8, Color(MUTED, text_alpha))
	var prompt_alpha := 0.55 + sin(visual_time * 5.0) * 0.35
	draw_string(PIXEL_FONT, Vector2(136, 142), "SPACE TO TRY AGAIN", HORIZONTAL_ALIGNMENT_CENTER, 208, 7, Color(GOLD, prompt_alpha * text_alpha))

# Deterministic factory hooks exercise the same public state transitions as play.
func factory_setup(_scenario: Dictionary) -> void:
	_reset()
	var center := guardians[1]
	guardians[1] = guardians[2]
	guardians[2] = center # one player-equivalent swap: seer rear, chime center, warden front
	_begin()

func factory_tick(delta: float) -> void:
	_advance(delta)

func factory_sample() -> Dictionary:
	return {"phase":phase, "time":battle_time, "order":_order(), "enemy_hp":enemies.map(func(e: Dictionary): return e.hp), "guardian_hp":guardians.map(func(g: Dictionary): return g.hp)}

func factory_collect() -> Dictionary:
	return {"passed":phase == "won", "phase":phase, "duration":battle_time, "order":_order(), "events":events}
