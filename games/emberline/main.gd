extends Node2D

# Emberline: The Fuse Fights Back
# A compact, code-native Godot tower defense built around five event-driven fuse bands.

const W := 1152.0
const H := 720.0
const STEADY := 0
const HOT := 1
const FRAYED := 2

# Living Instrument Workshop semantic tokens.
const VOID := Color("#0a0a0e")
const SOOT := Color("#121116")
const WALNUT := Color("#241713")
const WALNUT_LIGHT := Color("#3a241b")
const WALNUT_GLOW := Color("#5a3020")
const IRON := Color("#29282b")
const IRON_EDGE := Color("#514941")
const IRON_HIGHLIGHT := Color("#77706a")
const BRASS := Color("#dfa349")
const BRASS_DIM := Color("#7f613b")
const BRASS_DARK := Color("#4b3424")
const COPPER := Color("#c65a2e")
const COPPER_DARK := Color("#6d3025")
const EMBER := Color("#f56a32")
const DANGER := Color("#ff5a3d")
const COOL := Color("#73dde8")
const CYAN := Color("#84f4ef")
const BONE := Color("#d8cbb7")
const INK := Color("#f4e8d2")
const MUTED := Color("#a89991")

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
	"spark": {"name":"SPARK", "verb":"KINDLE", "cost":45, "range":154.0, "rate":0.66, "damage":7.0, "color":EMBER, "master":"ARC FORK", "master_desc":"chains a second target"},
	"bell": {"name":"COOLING BELL", "verb":"TEMPER", "cost":50, "range":142.0, "rate":1.08, "damage":3.0, "color":COOL, "master":"DEEP BOWL", "master_desc":"cools an adjacent band"},
	"striker": {"name":"STRIKER", "verb":"SHATTER", "cost":60, "range":126.0, "rate":1.32, "damage":16.0, "color":BRASS, "master":"TEMPERED FACE", "master_desc":"shatter gains splash"}
}
var wave_plans := [
	{"name":"FIRST LIGHT", "preview":"7 Cinders in two packets", "rule":"Compose two instrument verbs.", "hp":1.0, "pattern":["coal", "coal", "coal", "pause", "coal", "coal", "coal", "coal"]},
	{"name":"WEIGHT IN THE WIRE", "preview":"5 Cinders + 2 Rivet Carriers", "rule":"Rivets split a HOT fuse band.", "hp":1.16, "pattern":["coal", "coal", "iron", "coal", "pause", "iron", "coal", "coal"]},
	{"name":"CROSSCURRENT", "preview":"8 Cinders + 3 Rivet Carriers", "rule":"Cover two bands; vent before Rivets cross.", "hp":1.34, "pattern":["coal", "iron", "coal", "coal", "iron", "coal", "pause", "coal", "iron", "coal", "coal", "coal"]},
	{"name":"THE FURNACE WARDEN", "preview":"Escort + Warden + reinforcement", "rule":"CLAMP: Bell loosens -> Striker breaks.", "hp":1.48, "pattern":["coal", "coal", "warden", "pause", "coal", "iron", "coal", "iron"]}
]
var enemy_specs := {
	"coal":{"hp":34.0, "speed":54.0, "reward":8, "leak":1},
	"iron":{"hp":88.0, "speed":39.0, "reward":14, "leak":2},
	"warden":{"hp":410.0, "speed":25.0, "reward":90, "leak":12}
}

var mode := "title"
var selected_kind := "spark"
var selected_socket := -1
var hover_socket := -1
var hover_position := Vector2.ZERO
var keyboard_focus := ""
var coins := 110
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
var beats: Array = []
var fuse_states := [STEADY, STEADY, STEADY, STEADY, STEADY]
var fuse_causes := ["SEATED", "SEATED", "SEATED", "SEATED", "SEATED"]
var fuse_flash := [0.0, 0.0, 0.0, 0.0, 0.0]
var toast := ""
var toast_detail := ""
var toast_clock := 0.0
var game_paused := false
var game_speed := 1
var restart_confirm := false
var sound_muted := false
var reduced_fx := false
var visual_time := 0.0
var simulation_scale := 1.0
var factory_mode := false
var factory_scenario := "defensive"
var capture_hold := false

# Honest observed telemetry.
var enemies_spawned := 0
var enemies_spawned_by_role := {"coal":0, "iron":0, "warden":0}
var enemies_moved := 0.0
var enemies_accelerated_by_fray := 0
var shots_fired := 0
var enemies_defeated := 0
var enemies_defeated_by_role := {"coal":0, "iron":0, "warden":0}
var reactions_by_kind := {"flashboil":0, "temper":0, "shatter":0}
var fuse_transitions := 0
var fuse_transition_causes := {}
var max_frayed_bands := 0
var waves_completed := 0
var clamp_created := 0
var clamp_resolved := 0
var core_damage_taken := 0
var coins_earned := 0
var coins_spent := 0
var coins_refunded := 0
var fixture_credit_granted := 0
var starting_credit_issued := 110
var credit_abandoned_on_reset := 0
var placements := 0
var sales := 0
var masterworks := 0
var pause_toggles := 0
var speed_toggles := 0
var restart_count := 0
var defeat_seen := false
var victory_seen := false
var elapsed := 0.0
var victory_elapsed := 0.0
var wave_completion_times: Array = []
var max_enemy_progress_ratio := 0.0
var warden_max_progress_ratio := 0.0
var factory_plan_step := 0
var factory_plan_complete := false
var factory_action_log: Array = []

# Procedural one-shot audio; no external asset or credential dependency.
var audio_player: AudioStreamPlayer
var audio_generator: AudioStreamGenerator
var audio_playback: AudioStreamGeneratorPlayback

func _ready() -> void:
	setup_audio()
	set_process(true)
	queue_redraw()

func setup_audio() -> void:
	audio_generator = AudioStreamGenerator.new()
	audio_generator.mix_rate = 22050.0
	audio_generator.buffer_length = 0.35
	audio_player = AudioStreamPlayer.new()
	audio_player.stream = audio_generator
	audio_player.volume_db = -13.0
	add_child(audio_player)
	audio_player.play()
	audio_playback = audio_player.get_stream_playback()

func play_sfx(id: String) -> void:
	if sound_muted or factory_mode or audio_playback == null:
		return
	var frequency := 320.0
	var duration := 0.08
	var roughness := 0.0
	match id:
		"ui": frequency = 540.0; duration = 0.045
		"wave": frequency = 170.0; duration = 0.16; roughness = 0.08
		"spark": frequency = 760.0; duration = 0.055; roughness = 0.16
		"bell": frequency = 410.0; duration = 0.18
		"striker": frequency = 115.0; duration = 0.11; roughness = 0.1
		"flashboil": frequency = 920.0; duration = 0.12; roughness = 0.22
		"temper": frequency = 360.0; duration = 0.19
		"shatter": frequency = 150.0; duration = 0.14; roughness = 0.18
		"clamp": frequency = 82.0; duration = 0.24; roughness = 0.08
		"heart": frequency = 230.0; duration = 0.22
		"victory": frequency = 520.0; duration = 0.28
		"defeat": frequency = 98.0; duration = 0.34
	var frames := PackedVector2Array()
	var count := int(audio_generator.mix_rate * duration)
	for index in range(count):
		var t := float(index) / audio_generator.mix_rate
		var envelope := pow(1.0 - float(index) / maxf(1.0, float(count)), 1.8)
		var tone := sin(TAU * frequency * t) * 0.16
		tone += sin(TAU * frequency * 1.51 * t) * 0.055
		if roughness > 0.0:
			tone += sin(float(index * index) * 0.017) * roughness
		var sample := tone * envelope
		frames.append(Vector2(sample, sample))
	if audio_playback.can_push_buffer(frames.size()):
		audio_playback.push_buffer(frames)

func reset_game(count_restart := false) -> void:
	if count_restart:
		if factory_mode:
			credit_abandoned_on_reset += coins
			starting_credit_issued += 110
		restart_count += 1
	mode = "play"
	selected_kind = "spark"
	selected_socket = -1
	hover_socket = -1
	coins = 110
	core_health = 12
	wave = 0
	wave_active = false
	spawn_queue.clear()
	enemies.clear()
	towers.clear()
	bolts.clear()
	motes.clear()
	beats.clear()
	fuse_states = [STEADY, STEADY, STEADY, STEADY, STEADY]
	fuse_causes = ["SEATED", "SEATED", "SEATED", "SEATED", "SEATED"]
	fuse_flash = [0.0, 0.0, 0.0, 0.0, 0.0]
	game_paused = false
	game_speed = 1
	restart_confirm = false
	capture_hold = false
	factory_plan_step = 0
	factory_plan_complete = false
	if not factory_mode:
		reset_telemetry()
	toast_message("Seat two instruments, then light First Light.", "Each socket changes the order of contact.")
	queue_redraw()

func reset_telemetry() -> void:
	enemies_spawned = 0
	enemies_spawned_by_role = {"coal":0, "iron":0, "warden":0}
	enemies_moved = 0.0
	enemies_accelerated_by_fray = 0
	shots_fired = 0
	enemies_defeated = 0
	enemies_defeated_by_role = {"coal":0, "iron":0, "warden":0}
	reactions_by_kind = {"flashboil":0, "temper":0, "shatter":0}
	fuse_transitions = 0
	fuse_transition_causes = {}
	max_frayed_bands = 0
	waves_completed = 0
	clamp_created = 0
	clamp_resolved = 0
	core_damage_taken = 0
	coins_earned = 0
	coins_spent = 0
	coins_refunded = 0
	fixture_credit_granted = 0
	starting_credit_issued = 110
	credit_abandoned_on_reset = 0
	placements = 0
	sales = 0
	masterworks = 0
	pause_toggles = 0
	speed_toggles = 0
	restart_count = 0
	defeat_seen = false
	victory_seen = false
	elapsed = 0.0
	victory_elapsed = 0.0
	wave_completion_times = []
	max_enemy_progress_ratio = 0.0
	warden_max_progress_ratio = 0.0
	factory_plan_step = 0
	factory_plan_complete = false
	factory_action_log = []

func _process(delta: float) -> void:
	visual_time += delta * (0.28 if reduced_fx else 1.0)
	if toast_clock > 0.0:
		toast_clock -= delta
	update_visual_effects(delta)
	if mode != "play":
		queue_redraw()
		return
	if not game_paused and not restart_confirm and not capture_hold:
		var sim_delta := delta * simulation_scale * float(game_speed)
		elapsed += sim_delta
		update_simulation(sim_delta)
	queue_redraw()

func update_simulation(delta: float) -> void:
	for index in range(fuse_flash.size()):
		fuse_flash[index] = maxf(0.0, float(fuse_flash[index]) - delta)
	if wave_active:
		spawn_clock -= delta
		if spawn_clock <= 0.0 and not spawn_queue.is_empty():
			var entry: Dictionary = spawn_queue.pop_front()
			if String(entry.kind) == "pause":
				spawn_clock = float(entry.gap)
			else:
				spawn_enemy(entry)
				spawn_clock = float(entry.gap)
	update_enemies(delta)
	update_towers(delta)
	update_bolts(delta)
	if wave_active and spawn_queue.is_empty() and enemies.is_empty():
		complete_wave()
	if factory_mode and mode == "play" and not wave_active and wave < wave_plans.size():
		next_wave_clock -= delta
		if next_wave_clock <= 0.0:
			begin_wave()
			next_wave_clock = 1.1

func update_visual_effects(delta: float) -> void:
	for index in range(motes.size() - 1, -1, -1):
		motes[index].life -= delta
		motes[index].position += Vector2(motes[index].velocity) * delta
		motes[index].velocity = Vector2(motes[index].velocity) * 0.92
		if float(motes[index].life) <= 0.0:
			motes.remove_at(index)
	for index in range(beats.size() - 1, -1, -1):
		beats[index].life -= delta
		if float(beats[index].life) <= 0.0:
			beats.remove_at(index)
	for tower in towers:
		tower.recoil = maxf(0.0, float(tower.recoil) - delta * 7.0)
		tower.pulse = maxf(0.0, float(tower.pulse) - delta * 3.5)

func begin_wave() -> void:
	if mode != "play" or wave_active or wave >= wave_plans.size():
		return
	spawn_queue.clear()
	var plan: Dictionary = wave_plans[wave]
	for kind_value in plan.pattern:
		var kind := String(kind_value)
		if kind == "pause":
			spawn_queue.append({"kind":"pause", "gap":1.75})
			continue
		var base: Dictionary = enemy_specs[kind]
		var health := float(base.hp) * float(plan.hp)
		spawn_queue.append({"kind":kind, "hp":health, "speed":float(base.speed), "gap":0.78})
	wave += 1
	wave_active = true
	spawn_clock = 0.06
	toast_message(String(plan.name), String(plan.rule))
	play_sfx("wave")
	add_beat("wave", route[0] + Vector2(38, 0), BRASS, String(plan.name), 1.2)

func complete_wave() -> void:
	wave_active = false
	waves_completed += 1
	wave_completion_times.append(elapsed)
	for band in range(fuse_states.size()):
		if int(fuse_states[band]) > STEADY:
			change_band(band, -1, "RESPITE")
	# The respite stipend keeps a damaged but surviving player able to buy one
	# missing verb or one masterwork. A clean first wave still cannot buy both.
	var award := 36 + wave * 5
	coins += award
	coins_earned += award
	if wave >= wave_plans.size():
		mode = "victory"
		victory_seen = true
		victory_elapsed = elapsed
		play_sfx("victory")
	else:
		var next_plan: Dictionary = wave_plans[wave]
		toast_message("WAVE TEMPERED  +%d CREDIT" % award, "%s - %s" % [next_plan.name, next_plan.rule])

func spawn_enemy(plan: Dictionary) -> void:
	var kind := String(plan.kind)
	var health := float(plan.hp)
	enemies.append({
		"progress":0.0, "hp":health, "max_hp":health, "speed":float(plan.speed), "kind":kind,
		"kindled":0.0, "chilled":0.0, "brittle":0.0, "flash":0.0, "stun":0.0,
		"last_band":-1, "rivet_mask":0, "fray_mask":0,
		"clamp_state":"none", "clamp_target":-1, "clamp_timer":0.0, "clamp_triggered":false
	})
	enemies_spawned += 1
	enemies_spawned_by_role[kind] = int(enemies_spawned_by_role[kind]) + 1

func update_enemies(delta: float) -> void:
	for index in range(enemies.size() - 1, -1, -1):
		var enemy: Dictionary = enemies[index]
		enemy.kindled = maxf(0.0, float(enemy.kindled) - delta)
		enemy.chilled = maxf(0.0, float(enemy.chilled) - delta)
		enemy.brittle = maxf(0.0, float(enemy.brittle) - delta)
		enemy.flash = maxf(0.0, float(enemy.flash) - delta)
		enemy.stun = maxf(0.0, float(enemy.stun) - delta)
		var band := band_for_progress(float(enemy.progress))
		var progress_ratio := clampf(float(enemy.progress) / maxf(route_length(), 1.0), 0.0, 1.0)
		max_enemy_progress_ratio = maxf(max_enemy_progress_ratio, progress_ratio)
		if String(enemy.kind) == "warden":
			warden_max_progress_ratio = maxf(warden_max_progress_ratio, progress_ratio)
		if band != int(enemy.last_band):
			on_enemy_entered_band(enemy, band)
			enemy.last_band = band
		if String(enemy.kind) == "warden":
			update_warden_clamp(enemy, delta)
		var pace := float(enemy.speed)
		if float(enemy.chilled) > 0.0:
			pace *= 0.68
		if int(fuse_states[band]) == FRAYED:
			pace *= 1.26
			var bit := 1 << band
			if (int(enemy.fray_mask) & bit) == 0:
				enemy.fray_mask = int(enemy.fray_mask) | bit
				enemies_accelerated_by_fray += 1
		if String(enemy.clamp_state) == "closed":
			pace *= 0.56
		if float(enemy.stun) > 0.0 or String(enemy.clamp_state) == "warning":
			pace = 0.0
		enemy.progress += pace * delta
		enemies_moved += pace * delta
		if float(enemy.hp) <= 0.0:
			defeat_enemy(index, enemy)
		elif float(enemy.progress) >= route_length():
			leak_enemy(index, enemy)

func on_enemy_entered_band(enemy: Dictionary, band: int) -> void:
	if String(enemy.kind) != "iron":
		return
	var bit := 1 << band
	if (int(enemy.rivet_mask) & bit) != 0:
		return
	enemy.rivet_mask = int(enemy.rivet_mask) | bit
	if int(fuse_states[band]) == HOT:
		change_band(band, 1, "RIVET CROSSING")
		toast_message("FUSE FRAYED", "Rivet Carriers surge across split sheath.")
		add_beat("fray", band_marker_position(band), DANGER, "RIVET -> FRAYED", 1.1)
		play_sfx("striker")

func update_warden_clamp(enemy: Dictionary, delta: float) -> void:
	if not bool(enemy.clamp_triggered) and float(enemy.hp) <= float(enemy.max_hp) * 0.66:
		enemy.clamp_triggered = true
		enemy.clamp_state = "warning"
		enemy.clamp_target = mini(4, band_for_progress(float(enemy.progress)) + 1)
		enemy.clamp_timer = 1.05
		enemy.stun = 1.05
		clamp_created += 1
		toast_message("WARDEN CLAMP PRELOADING", "Target band %s: Bell loosens -> Striker breaks." % band_roman(int(enemy.clamp_target)))
		# Clamp language owns the persistent toast and the Warden silhouette. Keep
		# transient labels out of the heart-side combat lane.
		add_beat("clamp_warning", band_marker_position(int(enemy.clamp_target)), DANGER, "", 1.25)
		play_sfx("clamp")
		return
	if String(enemy.clamp_state) == "warning":
		enemy.clamp_timer = float(enemy.clamp_timer) - delta
		if float(enemy.clamp_timer) <= 0.0:
			enemy.clamp_state = "closed"
			change_band(int(enemy.clamp_target), 2, "WARDEN CLAMP")
			toast_message("CLAMP CLOSED - DAMAGE DEFLECTED", "Cooling Bell seats the collar; Striker breaks the seam.")
			add_beat("clamp_closed", band_marker_position(int(enemy.clamp_target)), DANGER, "", 1.4)
			play_sfx("clamp")

func defeat_enemy(index: int, enemy: Dictionary) -> void:
	var kind := String(enemy.kind)
	var reward := int(enemy_specs[kind].reward)
	coins += reward
	coins_earned += reward
	enemies_defeated += 1
	enemies_defeated_by_role[kind] = int(enemies_defeated_by_role[kind]) + 1
	var p := route_position(float(enemy.progress))
	burst(p, BRASS if kind == "iron" else EMBER, 7 if reduced_fx else 12)
	add_beat("kill", p, BRASS, "", 0.42)
	enemies.remove_at(index)

func leak_enemy(index: int, enemy: Dictionary) -> void:
	var damage := int(enemy_specs[String(enemy.kind)].leak)
	core_health -= damage
	core_damage_taken += damage
	burst(Vector2(1078, 326), DANGER, 6 if reduced_fx else 14)
	add_beat("heart", Vector2(1078, 326), DANGER, "-%d HEART" % damage, 0.9)
	play_sfx("heart")
	enemies.remove_at(index)
	if core_health <= 0:
		core_health = 0
		mode = "defeat"
		wave_active = false
		defeat_seen = true
		play_sfx("defeat")

func update_towers(delta: float) -> void:
	for tower in towers:
		tower.cooldown = maxf(0.0, float(tower.cooldown) - delta)
		if float(tower.cooldown) > 0.0:
			continue
		var target := find_target_for_tower(tower)
		if target < 0:
			continue
		fire_tower(tower, target)

func fire_tower(tower: Dictionary, target_index: int) -> void:
	if target_index < 0 or target_index >= enemies.size():
		return
	var enemy: Dictionary = enemies[target_index]
	var from := Vector2(tower.position)
	var to := route_position(float(enemy.progress))
	var kind := String(tower.kind)
	var damage := float(tower.damage)
	var reaction := ""
	var band := band_for_progress(float(enemy.progress))
	var clamp_state := String(enemy.clamp_state)
	if kind == "bell" and clamp_state == "closed":
		enemy.clamp_state = "loosened"
		reaction = "CLAMP LOOSENED"
		damage += 4.0
		toast_message(reaction, "Ceramic collar seated. Striker can break the seam.")
		add_beat("clamp_loose", to, COOL, "", 1.15)
		play_sfx("temper")
	elif kind == "striker" and clamp_state == "loosened":
		enemy.clamp_state = "broken"
		enemy.stun = 1.45
		reaction = "CLAMP BROKEN"
		damage += 52.0
		clamp_resolved += 1
		change_band(int(enemy.clamp_target), -1, "CLAMP BREAK")
		toast_message(reaction, "Shield gone. The Warden is staggered.")
		add_beat("clamp_break", to, BRASS, "", 1.25)
		play_sfx("shatter")
	else:
		match kind:
			"spark":
				if float(enemy.chilled) > 0.0:
					damage += 75.0
					enemy.chilled = 0.0
					reaction = "FLASHBOIL"
					change_band(band, 1, "FLASHBOIL")
				else:
					enemy.kindled = 2.8
			"bell":
				if float(enemy.kindled) > 0.0:
					damage += 10.0
					enemy.kindled = 0.0
					enemy.brittle = 4.2
					reaction = "TEMPER"
					change_band(band, -1, "TEMPER")
					if bool(tower.masterwork):
						cool_adjacent_band(band)
				else:
					# Chilled spans one authored socket handoff at Rivet pace, so a
					# visibly prepared Bell can actually reach the next Striker.
					enemy.chilled = 6.0
			"striker":
				if float(enemy.chilled) > 0.0 or float(enemy.brittle) > 0.0:
					# Prepared heavy blows are the plated-threat answer, not a small
					# modifier on raw DPS. A covered handoff dismantles early Rivets.
					damage += 64.0
					enemy.chilled = 0.0
					enemy.brittle = 0.0
					reaction = "SHATTER"
					change_band(band, -1, "SHATTER")
	if String(enemy.kind) == "iron" and reaction.is_empty():
		damage *= 0.58
	if String(enemy.clamp_state) == "closed":
		damage *= 0.18
	elif String(enemy.clamp_state) == "loosened":
		damage *= 0.45
	enemy.hp -= damage
	enemy.flash = 0.15
	if reaction in ["FLASHBOIL", "TEMPER", "SHATTER"]:
		register_reaction(reaction, to)
	if kind == "spark" and bool(tower.masterwork):
		var second := find_second_target(from, float(tower.range), target_index)
		if second >= 0:
			enemies[second].hp -= float(tower.damage) * 0.58
			enemies[second].flash = 0.09
			bolts.append({"from":to, "to":route_position(float(enemies[second].progress)), "life":0.11, "total":0.11, "color":EMBER, "kind":"chain"})
	if kind == "striker" and bool(tower.masterwork) and reaction == "SHATTER":
		for other in enemies:
			if other == enemy:
				continue
			if route_position(float(other.progress)).distance_to(to) < 58.0:
				other.hp -= 15.0
				other.flash = 0.11
	tower.cooldown = float(tower.rate)
	tower.recoil = 1.0
	tower.pulse = 1.0
	shots_fired += 1
	bolts.append({"from":from, "to":to, "life":0.15, "total":0.15, "color":Color(tower.color), "kind":kind, "reaction":not reaction.is_empty()})
	play_sfx(kind)

func register_reaction(reaction: String, position: Vector2) -> void:
	var key := reaction.to_lower()
	reactions_by_kind[key] = int(reactions_by_kind[key]) + 1
	var detail := ""
	var color := BRASS
	match reaction:
		"FLASHBOIL": detail = "burst damage; fuse heats"; color = EMBER; play_sfx("flashboil")
		"TEMPER": detail = "brittle set; fuse cools"; color = COOL; play_sfx("temper")
		"SHATTER": detail = "mark consumed; fuse vents"; color = BONE; play_sfx("shatter")
	toast_message(reaction, detail)
	# The toast carries the reaction name; the board beat stays physical so labels never stack over threats.
	add_beat(reaction.to_lower(), position, color, "", 0.95)

func update_bolts(delta: float) -> void:
	for index in range(bolts.size() - 1, -1, -1):
		bolts[index].life -= delta
		if float(bolts[index].life) <= 0.0:
			bolts.remove_at(index)

func find_target(position: Vector2, reach: float) -> int:
	var chosen := -1
	var best := -1.0
	for index in range(enemies.size()):
		var enemy_position := route_position(float(enemies[index].progress))
		if position.distance_to(enemy_position) <= reach and float(enemies[index].progress) > best:
			chosen = index
			best = float(enemies[index].progress)
	return chosen

func find_target_for_tower(tower: Dictionary) -> int:
	var chosen := -1
	var best := -INF
	var kind := String(tower.kind)
	var position := Vector2(tower.position)
	var reach := float(tower.range)
	for index in range(enemies.size()):
		var enemy: Dictionary = enemies[index]
		if position.distance_to(route_position(float(enemy.progress))) > reach:
			continue
		var score := float(enemy.progress)
		if kind == "striker":
			if String(enemy.kind) in ["iron", "warden"]:
				score += route_length() * 1.4
			if float(enemy.chilled) > 0.0 or float(enemy.brittle) > 0.0:
				score += route_length() * 3.0
		elif kind == "bell" and float(enemy.kindled) > 0.0:
			score += route_length() * 2.0
		elif kind == "spark" and float(enemy.chilled) > 0.0:
			score += route_length() * 2.0
		if score > best:
			best = score
			chosen = index
	return chosen

func find_second_target(position: Vector2, reach: float, excluded: int) -> int:
	var chosen := -1
	var best := -1.0
	for index in range(enemies.size()):
		if index == excluded:
			continue
		if position.distance_to(route_position(float(enemies[index].progress))) <= reach and float(enemies[index].progress) > best:
			chosen = index
			best = float(enemies[index].progress)
	return chosen

func change_band(band: int, amount: int, cause: String) -> void:
	if band < 0 or band >= fuse_states.size():
		return
	var old_state := int(fuse_states[band])
	var new_state := clampi(old_state + amount, STEADY, FRAYED)
	if amount >= 2:
		new_state = FRAYED
	if old_state == new_state:
		return
	fuse_states[band] = new_state
	fuse_causes[band] = cause
	fuse_flash[band] = 0.65
	fuse_transitions += 1
	fuse_transition_causes[cause] = int(fuse_transition_causes.get(cause, 0)) + 1
	max_frayed_bands = maxi(max_frayed_bands, count_fuse_state(FRAYED))

func cool_adjacent_band(band: int) -> void:
	# Deep Bowl cools the more stressed neighbor, so its description never hides
	# a left-only preference when the other adjacent band is visibly unsafe.
	var candidate := -1
	for neighbor in [band - 1, band + 1]:
		if neighbor < 0 or neighbor >= fuse_states.size():
			continue
		if int(fuse_states[neighbor]) > STEADY and (candidate < 0 or int(fuse_states[neighbor]) > int(fuse_states[candidate])):
			candidate = neighbor
	if candidate >= 0:
		change_band(candidate, -1, "DEEP BOWL")

func count_fuse_state(state: int) -> int:
	var count := 0
	for value in fuse_states:
		if int(value) == state:
			count += 1
	return count

func place_tower(socket_index: int, kind: String, free := false) -> bool:
	if socket_index < 0 or socket_index >= sockets.size() or socket_occupied(socket_index):
		invalid_feedback(socket_index)
		return false
	var spec: Dictionary = specs[kind]
	if not free and coins < int(spec.cost):
		toast_message("INSUFFICIENT CREDIT", "%s needs %d credit." % [spec.name, spec.cost])
		invalid_feedback(socket_index)
		return false
	if not free:
		coins -= int(spec.cost)
		coins_spent += int(spec.cost)
	placements += 1
	towers.append({
		"socket":socket_index, "position":sockets[socket_index], "kind":kind,
		"range":float(spec.range), "rate":float(spec.rate), "damage":float(spec.damage),
		"cooldown":0.0, "color":Color(spec.color), "masterwork":false, "recoil":0.0, "pulse":1.0
	})
	burst(sockets[socket_index], Color(spec.color), 5 if reduced_fx else 9)
	add_beat("seat", sockets[socket_index], BRASS, "SEATED", 0.52)
	play_sfx("ui")
	return true

func masterwork_selected() -> void:
	var tower_index := tower_at_socket(selected_socket)
	if tower_index < 0:
		return
	var tower: Dictionary = towers[tower_index]
	if bool(tower.masterwork):
		toast_message("MASTERWORK COMPLETE", String(specs[String(tower.kind)].master_desc))
		return
	var cost := 55
	if coins < cost:
		toast_message("MASTERWORK NEEDS 55 CREDIT", "Dismantling returns enough to rebuild.")
		return
	coins -= cost
	coins_spent += cost
	masterworks += 1
	tower.masterwork = true
	burst(Vector2(tower.position), BRASS, 6 if reduced_fx else 12)
	add_beat("masterwork", Vector2(tower.position), BRASS, String(specs[String(tower.kind)].master), 1.05)
	toast_message(String(specs[String(tower.kind)].master), String(specs[String(tower.kind)].master_desc))
	play_sfx("wave")

func sell_selected() -> void:
	var tower_index := tower_at_socket(selected_socket)
	if tower_index < 0:
		return
	var tower: Dictionary = towers[tower_index]
	var refund := int(round(float(specs[String(tower.kind)].cost) * 0.70))
	if bool(tower.masterwork):
		refund += 35
	coins += refund
	coins_refunded += refund
	sales += 1
	add_beat("dismantle", Vector2(tower.position), MUTED, "+%d CREDIT" % refund, 0.72)
	towers.remove_at(tower_index)
	selected_socket = -1
	play_sfx("ui")

func invalid_feedback(socket_index: int) -> void:
	var p := hover_position
	if socket_index >= 0 and socket_index < sockets.size():
		p = sockets[socket_index]
	add_beat("invalid", p, MUTED, "CLOSED", 0.45)
	play_sfx("ui")

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
	var remaining := clampf(progress, 0.0, route_length())
	for index in range(route.size() - 1):
		var segment := route[index].distance_to(route[index + 1])
		if remaining <= segment:
			return route[index].lerp(route[index + 1], remaining / maxf(segment, 0.001))
		remaining -= segment
	return route[-1]

func route_tangent(progress: float) -> Vector2:
	var before := route_position(maxf(0.0, progress - 3.0))
	var after := route_position(minf(route_length(), progress + 3.0))
	return before.direction_to(after)

func band_for_progress(progress: float) -> int:
	return clampi(int(floor(clampf(progress / maxf(route_length(), 1.0), 0.0, 0.9999) * 5.0)), 0, 4)

func band_marker_position(band: int) -> Vector2:
	return route_position(route_length() * (float(band) + 0.5) / 5.0)

func band_roman(band: int) -> String:
	return ["I", "II", "III", "IV", "V"][clampi(band, 0, 4)]

func burst(position: Vector2, color: Color, amount := 8) -> void:
	if reduced_fx:
		amount = mini(amount, 5)
	for index in range(amount):
		var angle := TAU * float(index) / maxf(1.0, float(amount))
		var speed := 28.0 + float(index % 3) * 12.0
		motes.append({"position":position, "velocity":Vector2.from_angle(angle) * speed, "life":0.46 + float(index % 2) * 0.14, "color":color})

func add_beat(kind: String, position: Vector2, color: Color, label: String, duration: float) -> void:
	beats.append({"kind":kind, "position":position, "color":color, "label":label, "life":duration, "total":duration})

func toast_message(message: String, detail := "") -> void:
	toast = message
	toast_detail = detail
	toast_clock = 2.5 if not detail.is_empty() else 3.2

func toggle_pause() -> void:
	if mode != "play":
		return
	game_paused = not game_paused
	pause_toggles += 1
	restart_confirm = false
	toast_message("WORKSHOP PAUSED" if game_paused else "FUSE RUNNING", "Placement, masterwork, and dismantle stay available." if game_paused else "Speed %dx" % game_speed)
	play_sfx("ui")

func toggle_speed() -> void:
	if mode != "play":
		return
	game_speed = 2 if game_speed == 1 else 1
	speed_toggles += 1
	toast_message("FUSE SPEED %dx" % game_speed, "Pause with P or the workshop plate.")
	play_sfx("ui")

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion:
		hover_position = event.position
		hover_socket = socket_at_position(event.position)
		queue_redraw()
	elif event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		keyboard_focus = ""
		press_at(event.position)
	elif event is InputEventKey and event.pressed and not event.echo:
		match event.keycode:
			KEY_SPACE:
				keyboard_focus = "wave"; begin_wave()
			KEY_P:
				keyboard_focus = "pause"; toggle_pause()
			KEY_R:
				keyboard_focus = "restart"
				if mode in ["victory", "defeat"]:
					reset_game(true)
				elif mode == "play":
					restart_confirm = not restart_confirm
			KEY_1:
				selected_kind = "spark"; keyboard_focus = "spark"
			KEY_2:
				selected_kind = "bell"; keyboard_focus = "bell"
			KEY_3:
				selected_kind = "striker"; keyboard_focus = "striker"

func socket_at_position(position: Vector2) -> int:
	for index in range(sockets.size()):
		if sockets[index].distance_to(position) <= 32.0:
			return index
	return -1

func press_at(position: Vector2) -> void:
	if mode == "title":
		if Rect2(429, 563, 294, 62).has_point(position):
			reset_game()
			play_sfx("wave")
		return
	if mode in ["victory", "defeat"]:
		if Rect2(438, 548, 276, 60).has_point(position):
			reset_game(true)
		return
	if restart_confirm:
		if Rect2(402, 414, 158, 52).has_point(position):
			restart_confirm = false
		elif Rect2(576, 414, 174, 52).has_point(position):
			reset_game(true)
		return
	if Rect2(900, 20, 70, 46).has_point(position):
		sound_muted = not sound_muted
		play_sfx("ui")
		return
	if Rect2(976, 20, 72, 46).has_point(position):
		reduced_fx = not reduced_fx
		play_sfx("ui")
		return
	if Rect2(1054, 20, 76, 46).has_point(position):
		restart_confirm = true
		return
	if Rect2(20, 644, 172, 62).has_point(position): selected_kind = "spark"; play_sfx("ui"); return
	if Rect2(200, 644, 172, 62).has_point(position): selected_kind = "bell"; play_sfx("ui"); return
	if Rect2(380, 644, 172, 62).has_point(position): selected_kind = "striker"; play_sfx("ui"); return
	if Rect2(780, 648, 64, 54).has_point(position): toggle_pause(); return
	if Rect2(850, 648, 76, 54).has_point(position): toggle_speed(); return
	if Rect2(934, 648, 198, 54).has_point(position): begin_wave(); return
	if selected_socket >= 0 and socket_occupied(selected_socket):
		if Rect2(42, 510, 194, 58).has_point(position): masterwork_selected(); return
		if Rect2(42, 574, 194, 44).has_point(position): sell_selected(); return
	var socket_index := socket_at_position(position)
	if socket_index >= 0:
		if socket_occupied(socket_index):
			selected_socket = socket_index
			play_sfx("ui")
		else:
			if place_tower(socket_index, selected_kind):
				selected_socket = socket_index
		return
	selected_socket = -1

func _draw() -> void:
	draw_rect(Rect2(0, 0, W, H), VOID)
	draw_workbench()
	if mode == "title":
		draw_title()
	else:
		draw_game()
		if mode == "victory":
			draw_ending(true)
		elif mode == "defeat":
			draw_ending(false)
		elif restart_confirm:
			draw_restart_confirm()

func draw_workbench() -> void:
	# Broad, value-separated walnut planks. Grain is restrained beneath tactical marks.
	for plank in range(9):
		var y := float(plank * 82)
		var shade := Color("#170d0c") if plank % 2 == 0 else Color("#1d110e")
		draw_rect(Rect2(0, y, W, 83), shade)
		draw_line(Vector2(0, y + 81), Vector2(W, y + 81), Color(0, 0, 0, 0.56), 3.0)
		draw_line(Vector2(0, y + 78), Vector2(W, y + 78), Color(WALNUT_GLOW, 0.15), 1.0)
	for index in range(46):
		var grain_y := 18.0 + float((index * 67) % 690)
		var grain_x := float((index * 131) % 310) - 110.0
		draw_bezier_grain(Vector2(grain_x, grain_y), float(440 + (index % 5) * 170), Color(0.34, 0.16, 0.085, 0.16))
	for index in range(10):
		var knot := Vector2(52 + (index * 127) % 1090, 36 + (index * 173) % 640)
		draw_arc(knot, 5.0 + float(index % 3) * 2.0, 0.2, 5.8, 20, Color(BRASS_DARK, 0.22), 1.2)
		draw_circle(knot, 2.0, Color(0, 0, 0, 0.42))

func draw_bezier_grain(start: Vector2, length: float, color: Color) -> void:
	var points := PackedVector2Array()
	for step in range(18):
		var t := float(step) / 17.0
		points.append(start + Vector2(length * t, sin(t * PI * 2.0 + start.y * 0.02) * 5.0))
	draw_polyline(points, color, 1.2, true)

func draw_board_surface(rect: Rect2) -> void:
	# A fitted walnut slab with a soot recess, cast shadow, worn rim, and quiet grain.
	draw_plate(Rect2(rect.position + Vector2(0, 7), rect.size), Color(0.015, 0.012, 0.014, 0.78), Color(0, 0, 0, 0), 9.0, 0.0)
	draw_plate(rect, Color("#211411"), IRON_EDGE, 9.0, 3.0)
	draw_plate(rect.grow(-7.0), Color("#160f0f"), BRASS_DARK, 6.0, 1.5)
	var inner := rect.grow(-13.0)
	for plank in range(6):
		var plank_height := inner.size.y / 6.0
		var plank_rect := Rect2(inner.position.x, inner.position.y + plank_height * plank, inner.size.x, plank_height + 1.0)
		var face := Color("#251612") if plank % 2 == 0 else Color("#2b1914")
		draw_rect(plank_rect, face)
		draw_line(Vector2(plank_rect.position.x, plank_rect.end.y), Vector2(plank_rect.end.x, plank_rect.end.y), Color(0, 0, 0, 0.42), 2.0)
	for index in range(24):
		var grain_y := inner.position.y + 18.0 + float((index * 43) % int(inner.size.y - 30.0))
		var grain_x := inner.position.x + float((index * 83) % 170) - 40.0
		draw_bezier_grain(Vector2(grain_x, grain_y), 310.0 + float(index % 4) * 170.0, Color(WALNUT_GLOW, 0.14))
	# Localized warm and cool falloff establishes the board's two focal temperatures.
	for ring in range(5, 0, -1):
		draw_circle(Vector2(604, 318), 94.0 + ring * 24.0, Color(EMBER, 0.006 * ring))
	for p in [rect.position + Vector2(16, 16), Vector2(rect.end.x - 16, rect.position.y + 16), Vector2(rect.position.x + 16, rect.end.y - 16), rect.end - Vector2(16, 16)]:
		draw_material_screw(p)

func draw_material_screw(p: Vector2) -> void:
	draw_circle(p + Vector2(1.5, 2.5), 6.0, Color(0, 0, 0, 0.55))
	draw_circle(p, 5.0, IRON)
	draw_circle(p - Vector2(1.0, 1.0), 3.7, IRON_EDGE)
	draw_line(p - Vector2(2.5, 0), p + Vector2(2.5, 0), Color("#171519"), 1.4)

func draw_title() -> void:
	# The title is a close workshop specimen: fitted walnut, physical instruments, and a precious heart.
	draw_board_surface(Rect2(78, 62, 996, 590))
	draw_plate(Rect2(118, 104, 582, 156), Color(0.035, 0.027, 0.028, 0.92), BRASS_DARK, 6.0, 1.5)
	draw_rect(Rect2(134, 119, 6, 124), COPPER_DARK)
	draw_string(ThemeDB.fallback_font, Vector2(158, 166), "E M B E R L I N E", HORIZONTAL_ALIGNMENT_LEFT, -1, 42, INK)
	draw_string(ThemeDB.fallback_font, Vector2(160, 201), "THE FUSE FIGHTS BACK", HORIZONTAL_ALIGNMENT_LEFT, -1, 18, BRASS)
	draw_string(ThemeDB.fallback_font, Vector2(160, 236), "Temper a living fuse. Defend the glass heart.", HORIZONTAL_ALIGNMENT_LEFT, -1, 18, BONE)
	# A small maker's seal and inventory marks occupy the former dead corner.
	draw_circle(Vector2(927, 168), 53, Color(0, 0, 0, 0.34))
	draw_circle(Vector2(927, 163), 48, IRON)
	draw_arc(Vector2(927, 163), 43, 0, TAU, 48, BRASS_DIM, 3.0)
	draw_arc(Vector2(927, 163), 31, -2.7, 2.7, 32, COPPER, 3.0)
	draw_line(Vector2(906, 163), Vector2(948, 163), BRASS_DARK, 3.0)
	draw_string(ThemeDB.fallback_font, Vector2(873, 235), "WORKSHOP 07", HORIZONTAL_ALIGNMENT_CENTER, 108, 14, MUTED)
	var title_route := PackedVector2Array([Vector2(142, 424), Vector2(278, 424), Vector2(332, 350), Vector2(478, 350), Vector2(548, 432), Vector2(696, 432), Vector2(758, 356), Vector2(892, 356)])
	for i in range(title_route.size() - 1):
		draw_fuse_segment(title_route[i], title_route[i + 1], STEADY)
	draw_title_instrument(Vector2(360, 328), "spark")
	draw_title_instrument(Vector2(590, 408), "bell")
	draw_title_instrument(Vector2(754, 332), "striker")
	draw_heart(Vector2(924, 356), 1.22, true)
	draw_plate(Rect2(144, 486, 650, 50), Color(0.035, 0.028, 0.03, 0.86), IRON_EDGE, 5.0, 1.0)
	draw_string(ThemeDB.fallback_font, Vector2(162, 518), "SPARK kindles   •   BELL tempers   •   STRIKER shatters", HORIZONTAL_ALIGNMENT_LEFT, -1, 16, BONE)
	draw_plate(Rect2(429, 563, 294, 62), Color("#73321f"), BRASS, 5.0, 2.0)
	draw_string(ThemeDB.fallback_font, Vector2(429, 602), "OPEN THE WORKSHOP", HORIZONTAL_ALIGNMENT_CENTER, 294, 18, INK)
	draw_focus(Rect2(429, 563, 294, 62), keyboard_focus == "open")

func draw_title_instrument(p: Vector2, kind: String) -> void:
	draw_instrument_body(p, kind, 1.28, 0.0, false)

func draw_game() -> void:
	draw_plate(Rect2(18, 14, 1116, 612), Color(0.03, 0.025, 0.027, 0.94), Color(0.24, 0.18, 0.16, 0.95), 7.0, 2.0)
	draw_board_surface(Rect2(26, 76, 1100, 542))
	draw_board_props()
	draw_route()
	draw_sockets_and_towers()
	draw_enemies()
	draw_effects()
	draw_header()
	draw_late_wave_ledger()
	draw_inspector()
	draw_toolbar()
	draw_toast()
	if game_paused:
		draw_plate(Rect2(421, 302, 310, 72), Color(0.035,0.03,0.035,0.96), COOL, 5.0, 2.0)
		draw_string(ThemeDB.fallback_font, Vector2(421, 332), "WORKSHOP PAUSED", HORIZONTAL_ALIGNMENT_CENTER, 310, 20, INK)
		draw_string(ThemeDB.fallback_font, Vector2(421, 356), "Build, masterwork, or dismantle.", HORIZONTAL_ALIGNMENT_CENTER, 310, 14, MUTED)

func draw_board_props() -> void:
	# Sparse physical specificity: a wax seal, wire spool, chalk marks, and fitted brackets.
	draw_circle(Vector2(56, 578) + Vector2(2, 4), 27, Color(0, 0, 0, 0.42))
	draw_circle(Vector2(56, 578), 25, Color("#4b241a"))
	draw_circle(Vector2(56, 578), 18, Color("#8a4025"))
	draw_arc(Vector2(56, 578), 14, 0, TAU, 28, Color("#b15b32"), 2.0)
	draw_circle(Vector2(56, 578), 5, Color("#211517"))
	for ring in range(3):
		draw_arc(Vector2(1082, 570), 15.0 + ring * 7.0, -2.8, 1.2, 24, Color(COPPER, 0.48 - ring * 0.08), 2.2)
	draw_line(Vector2(1066, 590), Vector2(1096, 603), COPPER_DARK, 3.0)
	for tick in range(4):
		draw_line(Vector2(302 + tick * 16, 596), Vector2(309 + tick * 16, 588), Color(BONE, 0.18), 1.5)
	for p in [Vector2(28, 78), Vector2(1124, 78), Vector2(28, 610), Vector2(1124, 610)]:
		draw_material_screw(p)

func draw_header() -> void:
	draw_string(ThemeDB.fallback_font, Vector2(38, 49), "EMBERLINE", HORIZONTAL_ALIGNMENT_LEFT, -1, 25, INK)
	draw_string(ThemeDB.fallback_font, Vector2(38, 70), "LIVING INSTRUMENT WORKSHOP 07", HORIZONTAL_ALIGNMENT_LEFT, -1, 14, MUTED)
	draw_string(ThemeDB.fallback_font, Vector2(293, 44), "CREDIT", HORIZONTAL_ALIGNMENT_LEFT, -1, 14, MUTED)
	draw_string(ThemeDB.fallback_font, Vector2(354, 48), str(coins), HORIZONTAL_ALIGNMENT_LEFT, -1, 22, BRASS)
	draw_string(ThemeDB.fallback_font, Vector2(420, 44), "HEART", HORIZONTAL_ALIGNMENT_LEFT, -1, 14, MUTED)
	for pip in range(12):
		var p := Vector2(476 + pip * 13, 42)
		draw_rect(Rect2(p - Vector2(5, 5), Vector2(10, 10)), Color("#182427") if pip < core_health else Color("#2b2327"), true)
		draw_rect(Rect2(p - Vector2(4, 4), Vector2(8, 8)), CYAN if pip < core_health else Color("#44363b"), true)
		if pip < core_health:
			draw_circle(p, 2.0, Color("#e7ffff"))
	draw_string(ThemeDB.fallback_font, Vector2(642, 48), "%d / 12" % core_health, HORIZONTAL_ALIGNMENT_LEFT, 72, 17, CYAN if core_health > 3 else DANGER)
	draw_plate(Rect2(900, 20, 70, 46), WALNUT, IRON_EDGE, 5.0, 1.0)
	draw_plate(Rect2(976, 20, 72, 46), WALNUT, IRON_EDGE, 5.0, 1.0)
	draw_plate(Rect2(1054, 20, 76, 46), WALNUT, IRON_EDGE, 5.0, 1.0)
	draw_string(ThemeDB.fallback_font, Vector2(900, 49), "MUTED" if sound_muted else "SOUND", HORIZONTAL_ALIGNMENT_CENTER, 70, 14, MUTED if sound_muted else INK)
	draw_string(ThemeDB.fallback_font, Vector2(976, 49), "FX LOW" if reduced_fx else "FX FULL", HORIZONTAL_ALIGNMENT_CENTER, 72, 14, MUTED if reduced_fx else INK)
	draw_string(ThemeDB.fallback_font, Vector2(1054, 49), "RESET", HORIZONTAL_ALIGNMENT_CENTER, 76, 14, INK)
	var plan_index := clampi(wave - 1 if wave_active else wave, 0, wave_plans.size() - 1)
	var plan: Dictionary = wave_plans[plan_index]
	draw_plate(Rect2(34, 84, 286, 88), Color(0.025,0.023,0.027,0.96), BRASS_DIM, 5.0, 1.0)
	draw_rect(Rect2(39, 91, 4, 72), BRASS_DARK)
	draw_string(ThemeDB.fallback_font, Vector2(50, 110), "%d / 4  %s" % [plan_index + 1, plan.name], HORIZONTAL_ALIGNMENT_LEFT, 254, 14, INK)
	draw_string(ThemeDB.fallback_font, Vector2(50, 136), String(plan.preview), HORIZONTAL_ALIGNMENT_LEFT, 254, 14, MUTED)
	draw_string(ThemeDB.fallback_font, Vector2(50, 160), String(plan.rule), HORIZONTAL_ALIGNMENT_LEFT, 254, 14, BRASS)

func draw_late_wave_ledger() -> void:
	# Bands IV and V share the Warden/heart lane. Move their persistent text to
	# a single collision-free ledger while the geometric band marks stay on the
	# fuse. This keeps status readable without covering actors or health bars.
	if not wave_active and wave < 3:
		return
	var late_states: Array[String] = []
	for band in [3, 4]:
		var state := int(fuse_states[band])
		var state_name := "STEADY" if state == STEADY else ("HOT" if state == HOT else "FRAYED")
		late_states.append("%s %s" % [band_roman(band), state_name])
	var warden := active_warden()
	var accent := BRASS
	var status := "WARDEN INBOUND"
	if not warden.is_empty():
		var clamp_state := String(warden.clamp_state).to_upper()
		status = "WARDEN  %d%%  /  CLAMP %s" % [int(round(100.0 * float(warden.hp) / maxf(float(warden.max_hp), 1.0))), clamp_state]
		accent = COOL if String(warden.clamp_state) == "loosened" else (BRASS if String(warden.clamp_state) == "broken" else DANGER)
	draw_plate(Rect2(704, 88, 408, 58), Color(0.025, 0.022, 0.026, 0.96), accent, 5.0, 1.5)
	draw_string(ThemeDB.fallback_font, Vector2(720, 111), status, HORIZONTAL_ALIGNMENT_LEFT, 376, 14, INK)
	draw_string(ThemeDB.fallback_font, Vector2(720, 135), "%s     %s" % [late_states[0], late_states[1]], HORIZONTAL_ALIGNMENT_LEFT, 376, 14, DANGER if FRAYED in [int(fuse_states[3]), int(fuse_states[4])] else MUTED)

func active_warden() -> Dictionary:
	for enemy in enemies:
		if String(enemy.kind) == "warden":
			return enemy
	return {}

func draw_route() -> void:
	var cumulative := 0.0
	for index in range(route.size() - 1):
		var a := route[index]
		var b := route[index + 1]
		var length := a.distance_to(b)
		var band := band_for_progress(cumulative + length * 0.5)
		var state := int(fuse_states[band])
		draw_fuse_segment(a, b, state)
		cumulative += length
	for band in range(5):
		draw_band_marker(band)
	draw_heart(Vector2(1080, 326), 1.08, mode != "defeat")

func draw_fuse_segment(a: Vector2, b: Vector2, state: int) -> void:
	var direction := a.direction_to(b)
	var normal := Vector2(-direction.y, direction.x)
	var length := a.distance_to(b)
	# Cast shadow, iron trough, worn edge, and inset sheath establish real depth before light.
	draw_line(a + Vector2(0, 8), b + Vector2(0, 8), Color(0,0,0,0.68), 35.0, true)
	draw_line(a, b, Color("#111116"), 31.0, true)
	draw_line(a - normal * 1.5, b - normal * 1.5, IRON_EDGE, 27.0, true)
	draw_line(a + normal * 1.5, b + normal * 1.5, IRON, 25.0, true)
	draw_line(a - normal * 9.5, b - normal * 9.5, Color(IRON_HIGHLIGHT, 0.62), 2.0, true)
	draw_line(a, b, Color("#3a201a"), 18.0, true)
	draw_line(a + normal * 6.5, b + normal * 6.5, Color(COPPER_DARK, 0.62), 2.0, true)
	if state == FRAYED:
		draw_line(a + normal * 4.8, b + normal * 4.8, Color(EMBER, 0.22), 9.0, true)
		draw_line(a + normal * 4.8, b + normal * 4.8, COPPER, 4.5, true)
		draw_line(a - normal * 4.8, b - normal * 4.8, Color(DANGER, 0.24), 8.0, true)
		draw_line(a - normal * 4.8, b - normal * 4.8, EMBER, 3.5, true)
		for step in range(10, int(length), 22):
			var p := a + direction * float(step)
			var branch_sign := 1.0 if (step / 22) % 2 == 0 else -1.0
			var branch := normal * branch_sign * (12.0 + float(step % 3))
			draw_line(p, p + branch + direction * 6.0, Color(EMBER, 0.94), 2.2, true)
			draw_circle(p + branch + direction * 6.0, 1.8, DANGER)
	else:
		var core_color := EMBER if state == HOT else COPPER
		var braid_width := 15.0 if state == HOT else 11.0
		draw_line(a, b, Color(core_color, 0.18 if state == STEADY else 0.34), braid_width + 6.0, true)
		draw_line(a, b, COPPER_DARK, braid_width, true)
		var filament_a := PackedVector2Array()
		var filament_b := PackedVector2Array()
		var point_count := maxi(3, int(length / 6.0))
		var turns := maxf(2.0, length / 19.0)
		var amplitude := 4.4 if state == HOT else 3.2
		for step in range(point_count + 1):
			var t := float(step) / float(point_count)
			var center := a.lerp(b, t)
			var wave_offset := sin(t * TAU * turns) * amplitude
			filament_a.append(center + normal * wave_offset)
			filament_b.append(center - normal * wave_offset)
		draw_polyline(filament_a, core_color, 3.2 if state == HOT else 2.6, true)
		draw_polyline(filament_b, Color(BRASS, 0.92), 2.0, true)
		draw_line(a - normal * amplitude, b - normal * amplitude, Color(INK, 0.12), 1.0, true)

func draw_band_marker(band: int) -> void:
	var p := band_marker_position(band)
	var state := int(fuse_states[band])
	var flash := float(fuse_flash[band])
	if flash > 0.0:
		draw_circle(p, 28.0 + flash * 9.0, Color(COOL if state == STEADY else DANGER, flash * 0.22))
	match state:
		STEADY:
			draw_circle(p + Vector2(0, 3), 17, Color(0, 0, 0, 0.55))
			draw_circle(p, 16, IRON)
			draw_arc(p, 15, 0, TAU, 28, BRASS, 3.5)
			draw_arc(p, 9, 0, TAU, 24, Color(COPPER,0.9), 2.5)
			draw_line(p + Vector2(9, -12), p + Vector2(15, -6), VOID, 4.0)
		HOT:
			draw_circle(p, 16, Color(EMBER, 0.24))
			draw_arc(p, 15, 0, TAU, 28, EMBER, 3.5)
			draw_plate(Rect2(p.x - 16, p.y - 38, 32, 23), IRON, EMBER, 3.0, 2.5)
			for x in [-9.0, 0.0, 9.0]:
				draw_line(p + Vector2(x, -31), p + Vector2(x, -20), BRASS, 2.5)
		FRAYED:
			var notch := PackedVector2Array([p + Vector2(-21,-19), p + Vector2(21,-19), p + Vector2(0,17)])
			draw_colored_polygon(PackedVector2Array([notch[0]+Vector2(0,4),notch[1]+Vector2(0,4),notch[2]+Vector2(0,4)]), Color(0,0,0,0.58))
			draw_colored_polygon(notch, IRON)
			draw_polyline(PackedVector2Array([notch[0],notch[1],notch[2],notch[0]]), DANGER, 3.0, true)
			draw_line(p + Vector2(0,-12), p + Vector2(0,1), DANGER, 4.0)
			draw_circle(p + Vector2(0,8), 2.7, DANGER)
	# Late-band text is rendered in the fixed ledger so it cannot collide with
	# the Warden, its health bar, the selected instrument, or the glass heart.
	if state == STEADY or band >= 3:
		return
	var label := "HOT" if state == HOT else "FRAYED"
	var label_y := p.y + 32.0 if band == 0 else p.y - 67.0
	draw_line(p + Vector2(0, -22 if band > 0 else 22), Vector2(p.x, label_y + (30 if band > 0 else 0)), Color(EMBER if state == HOT else DANGER, 0.72), 1.5)
	draw_plate(Rect2(p.x - 43, label_y, 86, 30), Color(0.04,0.035,0.04,0.96), EMBER if state == HOT else DANGER, 3.0, 1.5)
	draw_string(ThemeDB.fallback_font, Vector2(p.x - 43, label_y + 21), "%s  %s" % [band_roman(band), label], HORIZONTAL_ALIGNMENT_CENTER, 86, 14, INK)

func draw_sockets_and_towers() -> void:
	for index in range(sockets.size()):
		var p: Vector2 = sockets[index]
		var occupied := socket_occupied(index)
		var hovered := index == hover_socket
		var selected := index == selected_socket
		draw_circle(p + Vector2(0, 6), 31, Color(0,0,0,0.62))
		draw_circle(p, 29, Color("#151418"))
		draw_circle(p - Vector2(0, 1), 27, IRON_EDGE)
		draw_circle(p, 23, Color("#17161a"))
		draw_arc(p, 27, 0, TAU, 40, CYAN if selected else (BRASS if hovered else BRASS_DIM), 3.5 if selected else 2.2)
		for rivet_angle in [0.65, 2.5, 4.35]:
			draw_circle(p + Vector2.from_angle(rivet_angle) * 23.0, 2.2, BRASS_DIM)
		draw_line(p + Vector2(13,-20), p + Vector2(19,-14), VOID, 5.0)
		if not occupied:
			draw_circle(p, 11, Color(0,0,0,0.2))
			draw_line(p - Vector2(7,0), p + Vector2(7,0), BRASS_DIM, 2.0)
			draw_line(p - Vector2(0,7), p + Vector2(0,7), BRASS_DIM, 2.0)
	if hover_socket >= 0 and not socket_occupied(hover_socket):
		var ghost_p: Vector2 = sockets[hover_socket]
		var ghost_spec: Dictionary = specs[selected_kind]
		draw_circle(ghost_p, float(ghost_spec.range), Color(ghost_spec.color, 0.045))
		draw_arc(ghost_p, float(ghost_spec.range), 0, TAU, 72, Color(ghost_spec.color,0.58), 2.0)
		draw_instrument_body(ghost_p, selected_kind, 1.08, 0.0, true)
		var reachable_band := band_for_progress(nearest_route_progress(ghost_p))
		draw_mechanical_target_line(ghost_p, band_marker_position(reachable_band), Color(ghost_spec.color), "BAND %s" % band_roman(reachable_band))
	for tower in towers:
		var p := Vector2(tower.position)
		# Selection range is planning information. During combat it obscured the
		# exact late-wave threats it was meant to help target.
		if int(tower.socket) == selected_socket and not wave_active:
			draw_circle(p, float(tower.range), Color(tower.color, 0.045))
			draw_arc(p, float(tower.range), 0, TAU, 80, Color(tower.color, 0.62), 2.0)
			var target_index := find_target(p, float(tower.range))
			if target_index >= 0:
				draw_mechanical_target_line(p, route_position(float(enemies[target_index].progress)), Color(tower.color), "TARGET")
		draw_instrument_body(p, String(tower.kind), 1.08, float(tower.recoil), false)
		if bool(tower.masterwork):
			draw_arc(p, 31, -2.8, 0.15, 28, BRASS, 3.0)
			draw_circle(p + Vector2(21,-20), 4, BRASS)

func nearest_route_progress(position: Vector2) -> float:
	var best_distance := INF
	var best_progress := 0.0
	var cumulative := 0.0
	for index in range(route.size() - 1):
		var a := route[index]
		var b := route[index + 1]
		var length := a.distance_to(b)
		var t := clampf((position - a).dot(b - a) / maxf(1.0, length * length), 0.0, 1.0)
		var p := a.lerp(b, t)
		var distance := position.distance_to(p)
		if distance < best_distance:
			best_distance = distance
			best_progress = cumulative + length * t
		cumulative += length
	return best_progress

func draw_mechanical_target_line(from: Vector2, to: Vector2, color: Color, label: String) -> void:
	var segments := 12
	for step in range(0, segments, 2):
		var a := from.lerp(to, float(step) / float(segments))
		var b := from.lerp(to, float(step + 1) / float(segments))
		draw_line(a, b, Color(color, 0.72), 2.0, true)
	draw_arc(to, 20, -2.8, -1.85, 10, color, 2.5)
	draw_arc(to, 20, 0.35, 1.3, 10, color, 2.5)
	var label_x := clampf(to.x - 35.0, 28.0, W - 98.0)
	var label_y := to.y - 58.0 if to.y > 390.0 or to.x > 875.0 else to.y + 31.0
	draw_plate(Rect2(label_x, label_y, 70, 25), Color(0.03, 0.027, 0.03, 0.94), color, 3.0, 1.0)
	draw_string(ThemeDB.fallback_font, Vector2(label_x, label_y + 18), label, HORIZONTAL_ALIGNMENT_CENTER, 70, 14, INK)

func draw_instrument_body(p: Vector2, kind: String, scale_value: float, recoil: float, ghost: bool) -> void:
	var alpha := 0.42 if ghost else 1.0
	var offset := Vector2.ZERO
	if kind == "spark": offset = Vector2(-recoil * 3.0, recoil * 2.0)
	elif kind == "bell": offset = Vector2(0, recoil * 3.0)
	else: offset = Vector2(-recoil * 4.0, 0)
	draw_set_transform(p + offset, 0.0, Vector2.ONE * scale_value)
	match kind:
		"spark":
			# Tall copper spool with a shuttered aperture and a distinct round footing.
			draw_circle(Vector2(0, 10), 26, Color(0, 0, 0, 0.58 * alpha))
			draw_circle(Vector2(0, 6), 24, Color(IRON, alpha))
			draw_arc(Vector2(0, 6), 23, 0, TAU, 32, Color(BRASS_DIM, alpha), 4.0)
			draw_rect(Rect2(-16, -24, 32, 33), Color(IRON, alpha), true)
			draw_rect(Rect2(-14, -22, 28, 29), Color("#321c18", alpha), true)
			for coil in range(7):
				var coil_y := -19.0 + coil * 4.0
				draw_line(Vector2(-13, coil_y), Vector2(13, coil_y + (1.0 if coil % 2 == 0 else -1.0)), Color(COPPER if coil < 6 else BRASS, alpha), 2.6)
			draw_circle(Vector2(0, -5), 10, Color("#18161a", alpha))
			draw_arc(Vector2(0, -5), 10, -2.65, 2.65, 24, Color(BRASS, alpha), 2.4)
			draw_line(Vector2(-10, -5), Vector2(-2, -5), Color(EMBER, alpha), 3.5)
			draw_circle(Vector2(1, -31), 5.5, Color(BRASS_DIM, alpha))
			draw_circle(Vector2(1, -32), 3.5, Color(EMBER, alpha))
			draw_line(Vector2(-15, 8), Vector2(-19, 15), Color(IRON_HIGHLIGHT, alpha), 3.0)
			draw_line(Vector2(15, 8), Vector2(19, 15), Color(IRON_HIGHLIGHT, alpha), 3.0)
		"bell":
			# Broad crazed ceramic bowl with an octagonal cool footing.
			var base := PackedVector2Array([Vector2(-25, 3), Vector2(-18, -4), Vector2(18, -4), Vector2(25, 3), Vector2(22, 18), Vector2(-22, 18)])
			draw_colored_polygon(PackedVector2Array([base[0]+Vector2(0,5),base[1]+Vector2(0,5),base[2]+Vector2(0,5),base[3]+Vector2(0,5),base[4]+Vector2(0,5),base[5]+Vector2(0,5)]), Color(0,0,0,0.56*alpha))
			draw_colored_polygon(base, Color(IRON, alpha))
			draw_polyline(PackedVector2Array([base[0],base[1],base[2],base[3],base[4],base[5],base[0]]), Color(COOL, alpha), 3.0, true)
			var body := PackedVector2Array([Vector2(-22,12),Vector2(-16,-15),Vector2(-10,-25),Vector2(10,-25),Vector2(16,-15),Vector2(22,12)])
			draw_colored_polygon(body, Color(BONE,alpha))
			var inset := PackedVector2Array([Vector2(-17,9),Vector2(-12,-12),Vector2(-7,-20),Vector2(7,-20),Vector2(12,-12),Vector2(17,9)])
			draw_colored_polygon(inset, Color("#b9ad9d", alpha))
			draw_polyline(PackedVector2Array([body[0],body[1],body[2],body[3],body[4],body[5],body[0]]), Color("#ece1cd",alpha), 3.2, true)
			draw_arc(Vector2(0,11), 22, 0, PI, 28, Color(COOL,alpha), 4.5)
			draw_line(Vector2(-13, -7), Vector2(-5, -1), Color(IRON_EDGE, 0.65*alpha), 1.2)
			draw_line(Vector2(-5, -1), Vector2(-9, 7), Color(IRON_EDGE, 0.65*alpha), 1.2)
			draw_line(Vector2(12, -10), Vector2(5, -3), Color(IRON_EDGE, 0.55*alpha), 1.2)
			draw_circle(Vector2(0,-27), 6.0, Color(BRASS_DIM,alpha))
			draw_circle(Vector2(0,-28), 4.2, Color(CYAN,alpha))
			draw_circle(Vector2(-1,-29), 1.4, Color("#ecffff",alpha))
		"striker":
			# Squat directional iron press; the offset hammer owns the silhouette.
			draw_rect(Rect2(-24, -3, 51, 25), Color(0,0,0,0.58*alpha), true)
			draw_plate(Rect2(-25, -8, 50, 25), Color(IRON,alpha), Color(BRASS_DIM,alpha), 4.0, 2.5)
			draw_rect(Rect2(-18,-20,25,33), Color("#353337",alpha), true)
			draw_rect(Rect2(-18,-20,25,33), Color(IRON_HIGHLIGHT,alpha), false, 2.5)
			draw_line(Vector2(-12,-18),Vector2(-12,9),Color("#1a191c",alpha),3.0)
			draw_line(Vector2(-7,-23),Vector2(13,-34),Color(BRASS_DIM,alpha),6.0)
			draw_rect(Rect2(8,-42,25,16),Color("#222125",alpha),true)
			draw_rect(Rect2(8,-42,25,16),Color(IRON_HIGHLIGHT,alpha),false,3.0)
			draw_line(Vector2(30,-39),Vector2(30,-29),Color(BRASS,alpha),2.5)
			draw_line(Vector2(-20,11),Vector2(17,11),Color(BRASS_DARK,alpha),3.0)
			for scratch in range(3):
				draw_line(Vector2(11+scratch*5,-38),Vector2(15+scratch*5,-31),Color(BRASS_DIM,0.48*alpha),1.2)
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)

func draw_enemies() -> void:
	var foremost := -1
	var best := -1.0
	for index in range(enemies.size()):
		if float(enemies[index].progress) > best:
			best = float(enemies[index].progress)
			foremost = index
	if foremost >= 0 and (best > route_length() * 0.55 or String(enemies[foremost].kind) == "warden"):
		draw_threat_to_heart(best)
	for index in range(enemies.size()):
		var enemy: Dictionary = enemies[index]
		var progress := float(enemy.progress)
		var p := route_position(progress)
		var tangent := route_tangent(progress)
		var angle := tangent.angle()
		draw_enemy_actor(p, angle, enemy)
		if index == foremost:
			draw_threat_chevron(p, String(enemy.kind) == "warden")

func draw_threat_to_heart(progress: float) -> void:
	var lead := PackedVector2Array()
	for step in range(13):
		lead.append(route_position(lerpf(progress, route_length(), float(step) / 12.0)))
	draw_polyline(lead, Color(DANGER, 0.12), 4.0, true)
	draw_polyline(lead, Color(INK, 0.12), 1.0, true)

func draw_enemy_actor(p: Vector2, angle: float, enemy: Dictionary) -> void:
	var kind := String(enemy.kind)
	var status_color := COOL if float(enemy.chilled) > 0.0 or float(enemy.brittle) > 0.0 else (EMBER if float(enemy.kindled) > 0.0 else IRON_EDGE)
	if float(enemy.flash) > 0.0:
		status_color = INK
	draw_set_transform(p + Vector2(3,5), angle, Vector2.ONE)
	if kind == "coal":
		var shadow := PackedVector2Array([Vector2(-12,-5),Vector2(-7,-12),Vector2(3,-11),Vector2(11,-5),Vector2(10,6),Vector2(2,12),Vector2(-9,9),Vector2(-13,2)])
		draw_colored_polygon(shadow, Color(0,0,0,0.48))
	elif kind == "iron":
		draw_rect(Rect2(-18,-11,36,25),Color(0,0,0,0.48),true)
	else:
		draw_rect(Rect2(-31,-28,62,58),Color(0,0,0,0.52),true)
	draw_set_transform(p, angle, Vector2.ONE)
	match kind:
		"coal":
			var body := PackedVector2Array([Vector2(-13,-4),Vector2(-8,-12),Vector2(2,-10),Vector2(11,-5),Vector2(10,6),Vector2(3,11),Vector2(-9,8),Vector2(-12,1)])
			draw_colored_polygon(body, Color("#2c2323"))
			draw_polyline(PackedVector2Array([body[0],body[1],body[2],body[3],body[4],body[5],body[6],body[7],body[0]]), status_color, 2.0, true)
			draw_line(Vector2(-4,-6),Vector2(-1,6),Color(EMBER,0.8),2.0)
			draw_circle(Vector2(6,-2),2.0,EMBER)
		"iron":
			draw_plate(Rect2(-18,-12,36,24),Color("#353235"),status_color,3.0,2.0)
			draw_rect(Rect2(-8,-16,17,32),IRON,true)
			draw_line(Vector2(-12,0),Vector2(12,0),BRASS_DIM,3.0)
			for rivet in [Vector2(-13,-7),Vector2(13,-7),Vector2(-13,7),Vector2(13,7)]: draw_circle(rivet,2.1,BRASS)
		"warden":
			draw_warden_body(enemy)
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
	var radius := 38.0 if kind == "warden" else (18.0 if kind == "iron" else 14.0)
	var hp_ratio := clampf(float(enemy.hp) / maxf(float(enemy.max_hp),1.0), 0.0, 1.0)
	var health_y := p.y + 39.0 if kind == "warden" else p.y - radius - 14.0
	draw_rect(Rect2(p.x-radius-1,health_y,radius*2+2,8),Color("#160f12"),true)
	draw_rect(Rect2(p.x-radius,health_y+1,radius*2*hp_ratio,6),status_color,true)
	draw_line(Vector2(p.x-radius,health_y+1),Vector2(p.x-radius+radius*2*hp_ratio,health_y+1),Color(INK,0.28),1.0)
	if float(enemy.kindled) > 0.0:
		draw_line(p+Vector2(-4,-radius-17),p+Vector2(0,-radius-23),EMBER,2.0)
		draw_line(p+Vector2(0,-radius-23),p+Vector2(4,-radius-17),EMBER,2.0)
	if float(enemy.chilled) > 0.0 or float(enemy.brittle) > 0.0:
		draw_arc(p,radius+4,0,TAU,28,COOL,2.0)

func draw_warden_body(enemy: Dictionary) -> void:
	var clamp_state := String(enemy.clamp_state)
	draw_rect(Rect2(-36,-29,72,21),Color("#353236"),true)
	draw_rect(Rect2(-36,-29,72,21),IRON_HIGHLIGHT,false,3.0)
	draw_line(Vector2(-31,-25),Vector2(30,-25),Color(INK,0.15),2.0)
	draw_rect(Rect2(-35,-10,18,40),IRON,true)
	draw_rect(Rect2(17,-10,18,40),IRON,true)
	draw_line(Vector2(-31,-7),Vector2(-31,24),IRON_EDGE,3.0)
	draw_line(Vector2(31,-7),Vector2(31,24),IRON_EDGE,3.0)
	var gap := 10.0 if clamp_state == "loosened" else 3.0
	var left_jaw := PackedVector2Array([Vector2(-35,12),Vector2(-gap,12),Vector2(-gap,31),Vector2(-20,22),Vector2(-35,31)])
	var right_jaw := PackedVector2Array([Vector2(35,12),Vector2(gap,12),Vector2(gap,31),Vector2(20,22),Vector2(35,31)])
	draw_colored_polygon(left_jaw,IRON)
	draw_colored_polygon(right_jaw,IRON)
	draw_polyline(PackedVector2Array([left_jaw[0],left_jaw[1],left_jaw[2],left_jaw[3],left_jaw[4],left_jaw[0]]),IRON_HIGHLIGHT,2.0,true)
	draw_polyline(PackedVector2Array([right_jaw[0],right_jaw[1],right_jaw[2],right_jaw[3],right_jaw[4],right_jaw[0]]),IRON_HIGHLIGHT,2.0,true)
	for rivet in [Vector2(-27,-18),Vector2(-9,-18),Vector2(9,-18),Vector2(27,-18)]:
		draw_circle(rivet,3.5,BRASS_DARK)
		draw_circle(rivet-Vector2(0.5,0.8),2.2,BRASS)
	if clamp_state in ["warning","closed"]:
		draw_line(Vector2(-7,0),Vector2(7,0),DANGER,4.0)
		draw_line(Vector2(-4,-5),Vector2(4,5),DANGER,2.0)
	elif clamp_state == "loosened":
		draw_arc(Vector2.ZERO,27,-2.8,-0.35,24,COOL,5.0)
		draw_line(Vector2(-13,4),Vector2(13,4),BONE,7.0)
		draw_line(Vector2(-11,3),Vector2(11,3),Color("#f1e6d4"),2.0)
	elif clamp_state == "broken":
		draw_line(Vector2(-7,-6),Vector2(5,3),BRASS,3.0)
		draw_line(Vector2(5,3),Vector2(-2,12),BRASS,3.0)

func draw_threat_chevron(p: Vector2, boss: bool) -> void:
	var y := 45.0 if boss else 31.0
	var pulse := 2.0 * sin(visual_time * 4.0)
	for row in range(2 if boss else 1):
		var c := p + Vector2(0,-y-row*9-pulse)
		draw_line(c+Vector2(-8,-4),c, DANGER,3.0)
		draw_line(c,c+Vector2(8,-4),DANGER,3.0)

func draw_heart(p: Vector2, scale_value: float, lit: bool) -> void:
	if lit:
		for ring in range(6,0,-1):
			draw_circle(p, float(35 + ring*6)*scale_value, Color(CYAN,0.012*ring))
	# Heavy altar, glass well, and cage keep the heart from reading as a small HUD icon.
	draw_circle(p + Vector2(0, 31)*scale_value, 39*scale_value, Color(0,0,0,0.52))
	draw_circle(p + Vector2(0, 26)*scale_value, 37*scale_value, IRON)
	draw_arc(p + Vector2(0, 26)*scale_value, 36*scale_value, 0, TAU, 40, BRASS_DIM, 4.0*scale_value)
	draw_circle(p + Vector2(0,5)*scale_value, 38*scale_value, Color("#14282d") if lit else Color("#202024"))
	draw_arc(p + Vector2(0,5)*scale_value, 37*scale_value, 0, TAU, 40, BRASS, 4.0*scale_value)
	draw_arc(p + Vector2(0,5)*scale_value, 31*scale_value, -2.7, -0.45, 30, Color(INK,0.2), 2.0*scale_value)
	var heart_color := CYAN if lit else Color("#5e4b50")
	draw_circle(p + Vector2(-9,-5)*scale_value, 11*scale_value, heart_color)
	draw_circle(p + Vector2(9,-5)*scale_value, 11*scale_value, heart_color)
	var heart_poly := PackedVector2Array([p+Vector2(-19,-2)*scale_value,p+Vector2(19,-2)*scale_value,p+Vector2(0,24)*scale_value])
	draw_colored_polygon(heart_poly,heart_color)
	if lit:
		draw_circle(p+Vector2(-5,-7)*scale_value,3.5*scale_value,Color("#e8ffff"))
		draw_line(p+Vector2(-10,2)*scale_value,p+Vector2(-2,8)*scale_value,Color("#dfffff"),1.3*scale_value)
		draw_line(p+Vector2(-2,8)*scale_value,p+Vector2(-6,15)*scale_value,Color("#dfffff"),1.3*scale_value)
	for angle_index in range(4):
		var a := TAU*float(angle_index)/4.0+PI/4.0
		var outer := p+Vector2.from_angle(a)*38.0*scale_value
		var inner := p+Vector2.from_angle(a)*25.0*scale_value
		draw_line(inner,outer,IRON_HIGHLIGHT,3.2*scale_value)
		draw_circle(outer,2.2*scale_value,BRASS_DIM)

func draw_effects() -> void:
	for bolt in bolts:
		var life_ratio := clampf(float(bolt.life)/maxf(float(bolt.total),0.001),0.0,1.0)
		var from := Vector2(bolt.from)
		var to := Vector2(bolt.to)
		var color := Color(bolt.color,life_ratio)
		match String(bolt.kind):
			"spark","chain":
				var mid := from.lerp(to,0.5)+Vector2(0,-7*life_ratio)
				draw_polyline(PackedVector2Array([from,mid,to]),color,3.0 if bool(bolt.get("reaction",false)) else 2.0,true)
			"bell":
				draw_line(from,to,color,2.0,true)
				draw_arc(to,13.0*(1.0-life_ratio)+4.0,0,TAU,24,color,2.0)
			"striker":
				draw_line(from,to,color,4.0,true)
				draw_line(to-Vector2(7,7),to+Vector2(7,7),color,2.0)
				draw_line(to+Vector2(7,-7),to-Vector2(7,7),color,2.0)
	for mote in motes:
		var alpha := clampf(float(mote.life)*2.0,0.0,1.0)
		draw_circle(Vector2(mote.position),2.2,Color(mote.color,alpha))
	for beat in beats:
		draw_beat(beat)

func draw_beat(beat: Dictionary) -> void:
	var ratio := clampf(float(beat.life)/maxf(float(beat.total),0.001),0.0,1.0)
	var p := Vector2(beat.position)
	var color := Color(beat.color,ratio)
	match String(beat.kind):
		"flashboil":
			draw_arc(p,12.0+(1.0-ratio)*26.0,0,TAU,28,color,4.0)
			draw_circle(p, 7.0 + (1.0-ratio)*5.0, Color(EMBER, ratio*0.28))
		"temper","clamp_loose":
			draw_arc(p,9.0+(1.0-ratio)*31.0,0,TAU,28,color,3.0)
			for x in [-10.0,0.0,10.0]: draw_line(p+Vector2(x,5),p+Vector2(x-3,-8),Color(COOL,ratio*0.65),1.5)
			draw_line(p+Vector2(-13,2),p+Vector2(13,2),Color(BONE,ratio),5.0)
		"shatter","clamp_break":
			for angle in [-0.8,0.0,0.8]:
				var d := Vector2.from_angle(angle-PI/2.0)*(18.0+(1.0-ratio)*18.0)
				draw_line(p,p+d,color,4.0)
		"clamp_warning","clamp_closed":
			draw_arc(p,30.0+(1.0-ratio)*8.0,-2.8,-0.35,26,color,4.0)
		"heart":
			draw_arc(p,38.0+(1.0-ratio)*18.0,0,TAU,32,color,3.0)
		_:
			draw_arc(p,13.0+(1.0-ratio)*16.0,0,TAU,24,color,2.0)
	if not String(beat.label).is_empty() and ratio > 0.22:
		var label_width := 220.0 if String(beat.label).length() > 16 else 150.0
		var label_x := clampf(p.x - label_width * 0.5, 24.0, W - label_width - 24.0)
		var label_y := p.y - 64.0 - (1.0-ratio)*8.0
		draw_plate(Rect2(label_x,label_y,label_width,29),Color(0.025,0.022,0.026,ratio*0.94),color,3.0,1.0)
		draw_string(ThemeDB.fallback_font,Vector2(label_x,label_y+21),String(beat.label),HORIZONTAL_ALIGNMENT_CENTER,label_width,14,INK)

func draw_inspector() -> void:
	if selected_socket < 0 or not socket_occupied(selected_socket):
		return
	var tower: Dictionary = towers[tower_at_socket(selected_socket)]
	var spec: Dictionary = specs[String(tower.kind)]
	draw_plate(Rect2(30,454,214,166),Color(0.04,0.034,0.038,0.98),Color(tower.color),6.0,2.0)
	draw_rect(Rect2(36,462,4,38), Color(tower.color))
	draw_string(ThemeDB.fallback_font,Vector2(48,481),String(spec.name),HORIZONTAL_ALIGNMENT_LEFT,184,17,INK)
	draw_string(ThemeDB.fallback_font,Vector2(48,503),"%s  •  %s" % [spec.verb,spec.master if bool(tower.masterwork) else "MK I"],HORIZONTAL_ALIGNMENT_LEFT,184,14,Color(tower.color))
	draw_plate(Rect2(42,510,194,58),WALNUT,BRASS if coins>=55 and not bool(tower.masterwork) else IRON_EDGE,5.0,1.0)
	draw_string(ThemeDB.fallback_font,Vector2(42,536),"MASTERWORK  55" if not bool(tower.masterwork) else "MASTERWORKED",HORIZONTAL_ALIGNMENT_CENTER,194,14,INK if coins>=55 or bool(tower.masterwork) else MUTED)
	draw_string(ThemeDB.fallback_font,Vector2(42,558),String(spec.master_desc),HORIZONTAL_ALIGNMENT_CENTER,194,14,MUTED)
	draw_plate(Rect2(42,574,194,44),Color("#1b181c"),IRON_EDGE,5.0,1.0)
	var refund := int(round(float(spec.cost)*0.70))+(35 if bool(tower.masterwork) else 0)
	draw_string(ThemeDB.fallback_font,Vector2(42,602),"DISMANTLE  +%d" % refund,HORIZONTAL_ALIGNMENT_CENTER,194,14,MUTED)

func draw_toolbar() -> void:
	draw_rect(Rect2(0,632,W,88),Color("#151318"),true)
	draw_line(Vector2(0,632),Vector2(W,632),Color("#4b3630"),2.0)
	var kinds := ["spark","bell","striker"]
	for index in range(kinds.size()):
		var kind := String(kinds[index])
		var rect := Rect2(20+index*180,644,172,62)
		var selected := kind==selected_kind
		var affordable := coins>=int(specs[kind].cost)
		draw_plate(rect,Color("#34231f") if selected else Color("#211c20"),Color(specs[kind].color) if selected else (BRASS_DIM if affordable else IRON_EDGE),5.0,2.0 if selected else 1.0)
		draw_instrument_icon(Vector2(rect.position.x+23,rect.position.y+29),kind,Color(specs[kind].color) if affordable else MUTED)
		var plate_name := "BELL TEMPER" if kind == "bell" else "%s %s" % [specs[kind].name,specs[kind].verb]
		draw_string(ThemeDB.fallback_font,Vector2(rect.position.x+43,rect.position.y+25),plate_name,HORIZONTAL_ALIGNMENT_LEFT,126,14,INK if affordable else MUTED)
		draw_string(ThemeDB.fallback_font,Vector2(rect.position.x+45,rect.position.y+49),"%d credit  [%d]" % [specs[kind].cost,index+1],HORIZONTAL_ALIGNMENT_LEFT,120,14,BRASS if affordable else MUTED)
		draw_focus(rect,keyboard_focus==kind)
	draw_string(ThemeDB.fallback_font,Vector2(570,663),"WAVE %d / 4" % wave,HORIZONTAL_ALIGNMENT_LEFT,-1,16,INK)
	draw_string(ThemeDB.fallback_font,Vector2(570,688),"%d HOT  /  %d FRAYED" % [count_fuse_state(HOT),count_fuse_state(FRAYED)],HORIZONTAL_ALIGNMENT_LEFT,-1,14,DANGER if count_fuse_state(FRAYED)>0 else MUTED)
	draw_plate(Rect2(780,648,64,54),WALNUT,COOL if game_paused else IRON_EDGE,5.0,1.0)
	draw_string(ThemeDB.fallback_font,Vector2(780,680),"RUN" if game_paused else "PAUSE",HORIZONTAL_ALIGNMENT_CENTER,64,14,INK)
	draw_string(ThemeDB.fallback_font,Vector2(780,698),"[P]",HORIZONTAL_ALIGNMENT_CENTER,64,14,MUTED)
	draw_plate(Rect2(850,648,76,54),WALNUT,BRASS_DIM,5.0,1.0)
	draw_string(ThemeDB.fallback_font,Vector2(850,680),"SPEED %dx" % game_speed,HORIZONTAL_ALIGNMENT_CENTER,76,14,INK)
	draw_string(ThemeDB.fallback_font,Vector2(850,698),"click",HORIZONTAL_ALIGNMENT_CENTER,76,14,MUTED)
	var wave_ready := not wave_active and wave<wave_plans.size()
	draw_plate(Rect2(934,648,198,54),Color("#70311e") if wave_ready else Color("#211d21"),BRASS if wave_ready else IRON_EDGE,5.0,2.0 if wave_ready else 1.0)
	var wave_label := "LIGHT NEXT WAVE" if wave_ready else ("FUSE BURNING" if wave_active else "RUN COMPLETE")
	draw_string(ThemeDB.fallback_font,Vector2(934,681),wave_label,HORIZONTAL_ALIGNMENT_CENTER,198,14,INK if wave_ready else MUTED)
	draw_string(ThemeDB.fallback_font,Vector2(934,700),"[SPACE]" if wave_ready else "",HORIZONTAL_ALIGNMENT_CENTER,198,14,MUTED)
	draw_focus(Rect2(780,648,64,54),keyboard_focus=="pause")
	draw_focus(Rect2(934,648,198,54),keyboard_focus=="wave")

func draw_instrument_icon(p: Vector2, kind: String, color: Color) -> void:
	match kind:
		"spark":
			draw_arc(p,9,-2.5,2.5,18,color,3.0); draw_line(p+Vector2(0,-12),p+Vector2(0,-4),color,2.0)
		"bell":
			draw_arc(p,11,PI,TAU,20,color,4.0); draw_line(p+Vector2(-7,-2),p+Vector2(-4,-10),color,3.0); draw_line(p+Vector2(7,-2),p+Vector2(4,-10),color,3.0)
		"striker":
			draw_rect(Rect2(p-Vector2(9,8),Vector2(15,17)),color,false,3.0); draw_line(p+Vector2(-3,-10),p+Vector2(11,-17),color,4.0)

func draw_toast() -> void:
	if toast_clock <= 0.0:
		return
	var width := 510.0
	var rect := Rect2(300,548,width,45 if toast_detail.is_empty() else 70)
	draw_plate(rect,Color(0.025,0.022,0.026,0.96),BRASS_DIM,5.0,1.0)
	draw_string(ThemeDB.fallback_font,Vector2(rect.position.x+14,rect.position.y+26),toast,HORIZONTAL_ALIGNMENT_CENTER,width-28,15,INK)
	if not toast_detail.is_empty():
		draw_string(ThemeDB.fallback_font,Vector2(rect.position.x+14,rect.position.y+52),toast_detail,HORIZONTAL_ALIGNMENT_CENTER,width-28,14,MUTED)

func draw_ending(won: bool) -> void:
	draw_rect(Rect2(0,0,W,H),Color(0.018,0.016,0.02,0.84),true)
	draw_plate(Rect2(294,112,564,520),Color("#171419"),CYAN if won else DANGER,7.0,3.0)
	draw_heart(Vector2(576,238),1.2,won)
	draw_string(ThemeDB.fallback_font,Vector2(326,339),"HEART TEMPERED" if won else "FUSE BREACHED",HORIZONTAL_ALIGNMENT_CENTER,500,34,INK)
	draw_string(ThemeDB.fallback_font,Vector2(356,385),"THE WARDEN YIELDS. THE FUSE SINGS." if won else "THE FILAMENT IS DARK. RESEAT THE WORKSHOP.",HORIZONTAL_ALIGNMENT_CENTER,440,14,BRASS if won else MUTED)
	draw_plate(Rect2(372,416,408,96),Color(0.035,0.03,0.035,0.9),IRON_EDGE,5.0,1.0)
	draw_string(ThemeDB.fallback_font,Vector2(392,447),"%d threats dismantled     %d reactions" % [enemies_defeated,total_reactions()],HORIZONTAL_ALIGNMENT_CENTER,368,14,INK)
	draw_string(ThemeDB.fallback_font,Vector2(392,476),"%d fuse transitions      %d / 12 heart" % [fuse_transitions,core_health],HORIZONTAL_ALIGNMENT_CENTER,368,14,CYAN if won else MUTED)
	draw_string(ThemeDB.fallback_font,Vector2(392,499),"Max FRAYED bands: %d" % max_frayed_bands,HORIZONTAL_ALIGNMENT_CENTER,368,14,MUTED)
	draw_plate(Rect2(438,548,276,60),Color("#71321f"),BRASS,5.0,2.0)
	draw_string(ThemeDB.fallback_font,Vector2(438,585),"REOPEN WORKSHOP  [R]",HORIZONTAL_ALIGNMENT_CENTER,276,16,INK)

func draw_restart_confirm() -> void:
	draw_rect(Rect2(0,0,W,H),Color(0.01,0.01,0.012,0.7),true)
	draw_plate(Rect2(360,278,432,214),Color("#171419"),BRASS,7.0,2.0)
	draw_string(ThemeDB.fallback_font,Vector2(384,326),"RESEAT THE ENTIRE WORKSHOP?",HORIZONTAL_ALIGNMENT_CENTER,384,22,INK)
	draw_string(ThemeDB.fallback_font,Vector2(398,365),"Current wave, credit, and fuse state will be cleared.",HORIZONTAL_ALIGNMENT_CENTER,356,14,MUTED)
	draw_plate(Rect2(402,414,158,52),WALNUT,IRON_EDGE,5.0,1.0)
	draw_string(ThemeDB.fallback_font,Vector2(402,446),"CANCEL",HORIZONTAL_ALIGNMENT_CENTER,158,14,INK)
	draw_plate(Rect2(576,414,174,52),Color("#642a1d"),DANGER,5.0,2.0)
	draw_string(ThemeDB.fallback_font,Vector2(576,446),"RESTART",HORIZONTAL_ALIGNMENT_CENTER,174,14,INK)

func draw_plate(rect: Rect2, fill: Color, border: Color, chamfer := 5.0, border_width := 1.0) -> void:
	var x := rect.position.x
	var y := rect.position.y
	var right := rect.end.x
	var bottom := rect.end.y
	var points := PackedVector2Array([Vector2(x+chamfer,y),Vector2(right-chamfer,y),Vector2(right,y+chamfer),Vector2(right,bottom-chamfer),Vector2(right-chamfer,bottom),Vector2(x+chamfer,bottom),Vector2(x,bottom-chamfer),Vector2(x,y+chamfer)])
	if fill.a > 0.04 and border_width > 0.0:
		var shadow := PackedVector2Array()
		for point in points:
			shadow.append(point + Vector2(0, 3.0))
		draw_colored_polygon(shadow, Color(0, 0, 0, minf(0.48, fill.a * 0.55)))
	draw_colored_polygon(points,fill)
	var closed := PackedVector2Array(points)
	closed.append(points[0])
	if border_width > 0.0:
		draw_polyline(closed,border,border_width,true)
		draw_line(points[0] + Vector2(2, 1), points[1] - Vector2(2, -1), Color(border.lightened(0.2), minf(border.a, 0.72)), minf(1.5, border_width), true)

func draw_focus(rect: Rect2, active: bool) -> void:
	if not active:
		return
	draw_plate(rect.grow(3.0),Color(0,0,0,0),CYAN,7.0,3.0)

func total_reactions() -> int:
	return int(reactions_by_kind.flashboil)+int(reactions_by_kind.temper)+int(reactions_by_kind.shatter)

# Deterministic GameFactory hooks. These exercise actual simulation state.
func factory_setup(parameters: Dictionary) -> void:
	factory_mode = true
	factory_scenario = "capture" if bool(parameters.get("capture",false)) else String(parameters.get("scenario","defensive"))
	simulation_scale = 4.0 if factory_scenario == "capture" else float(parameters.get("simulation_scale",18.0))
	reset_telemetry()
	reset_game()
	if factory_scenario == "capture":
		# Reachable opening plan: two paid instruments leave the missing-verb choice visible.
		place_tower(0,"bell"); place_tower(1,"spark")
		selected_kind = "striker"
		hover_socket = 5
		hover_position = sockets[5]
		beats.clear(); motes.clear()
		toast_message("CHOOSE THE NEXT CONTACT", "Hover an empty socket to preview reach and its nearest fuse band.")
		next_wave_clock = 999.0
	elif factory_scenario == "defeat_replay":
		core_health = 3
		next_wave_clock = 0.03
	else:
		apply_factory_layout(factory_scenario)
		next_wave_clock = 0.03

func apply_factory_layout(layout: String) -> void:
	# Acceptance plans begin with exactly the player's 110 credit. Every later
	# placement, masterwork, sale, and rebuild is staged between real waves.
	factory_plan_step = 0
	factory_plan_complete = false
	if layout == "aggressive":
		if place_tower(0, "bell") and place_tower(1, "spark"):
			factory_plan_step = 1
			record_factory_action("opening: Bell -> Spark")
	else:
		if place_tower(0, "bell") and place_tower(1, "striker"):
			factory_plan_step = 1
			record_factory_action("opening: Bell -> Striker")

func factory_strategy_name() -> String:
	return "defensive" if factory_scenario == "defeat_replay" else factory_scenario

func record_factory_action(action: String) -> void:
	factory_action_log.append({
		"action":action, "after_wave":waves_completed, "coins_after":coins,
		"credit_spent":coins_spent, "credit_refunded":coins_refunded
	})

func factory_masterwork(socket_index: int) -> bool:
	var tower_index := tower_at_socket(socket_index)
	if tower_index < 0 or bool(towers[tower_index].masterwork) or coins < 55:
		return false
	selected_socket = socket_index
	masterwork_selected()
	return bool(towers[tower_index].masterwork)

func execute_factory_plan() -> void:
	if mode != "play" or wave_active or factory_plan_step <= 0 or factory_plan_complete:
		return
	var strategy := factory_strategy_name()
	if strategy == "aggressive":
		if factory_plan_step == 1 and waves_completed >= 1 and coins >= 60:
			if place_tower(2, "striker"):
				factory_plan_step = 2
				record_factory_action("wave 1: add plated-threat payoff")
		elif factory_plan_step == 2 and waves_completed >= 2 and coins >= 68:
			# The temporary early Striker kept the first Rivets survivable. Move
			# that paid coverage into a Bell/Striker reaction pair for wave three.
			selected_socket = 2
			sell_selected()
			if place_tower(4, "bell") and place_tower(6, "striker"):
				factory_plan_step = 3
				record_factory_action("wave 2: relocate into Temper -> Shatter")
		elif factory_plan_step == 3 and waves_completed >= 3 and coins >= 165:
			# The Warden forecast adds a late paid clamp response while Arc Fork
			# preserves the build's immediate-kill identity.
			if place_tower(7, "bell") and place_tower(8, "striker") and factory_masterwork(1):
				factory_plan_step = 4
				factory_plan_complete = true
				record_factory_action("wave 3: forecast clamp response")
	else:
		if factory_plan_step == 1 and waves_completed >= 1 and coins >= 45:
			if place_tower(2, "spark"):
				factory_plan_step = 2
				record_factory_action("wave 1: add finisher")
		elif factory_plan_step == 2 and waves_completed >= 2 and coins >= 110:
			if place_tower(5, "bell") and place_tower(6, "striker"):
				factory_plan_step = 3
				record_factory_action("wave 2: second safe contact")
		elif factory_plan_step == 3 and waves_completed >= 3 and coins >= 115:
			if place_tower(8, "striker") and factory_masterwork(6):
				factory_plan_step = 4
				factory_plan_complete = true
				record_factory_action("wave 3: late Striker plus Tempered Face")

func setup_capture_wave_fixture() -> void:
	# A deterministic late-wave composition for visual inspection. It is frozen and
	# reported as a fixture, never as a naturally completed run or human play evidence.
	towers.clear(); enemies.clear(); bolts.clear(); motes.clear(); beats.clear()
	coins = 260
	coins_spent = 0
	coins_earned = 0
	coins_refunded = 0
	fixture_credit_granted = 150
	placements = 0
	masterworks = 0
	place_tower(6, "spark"); place_tower(7, "bell"); place_tower(8, "striker")
	beats.clear(); motes.clear()
	selected_socket = 8
	hover_socket = -1
	wave = 4
	wave_active = true
	spawn_queue = [{"kind":"coal", "hp":50.0, "speed":54.0, "gap":0.8}]
	fuse_states = [STEADY, HOT, STEADY, FRAYED, FRAYED]
	fuse_causes = ["RESPITE", "FLASHBOIL", "RESPITE", "RIVET CROSSING", "WARDEN CLAMP"]
	fuse_flash = [0.0, 0.0, 0.0, 0.0, 0.45]
	var warden_progress := route_length() * 0.84
	var iron_progress := route_length() * 0.74
	var coal_progress := route_length() * 0.67
	enemies.append({"progress":coal_progress,"hp":38.0,"max_hp":50.0,"speed":54.0,"kind":"coal","kindled":1.8,"chilled":0.0,"brittle":0.0,"flash":0.0,"stun":0.0,"last_band":3,"rivet_mask":0,"fray_mask":0,"clamp_state":"none","clamp_target":-1,"clamp_timer":0.0,"clamp_triggered":false})
	enemies.append({"progress":iron_progress,"hp":92.0,"max_hp":118.0,"speed":39.0,"kind":"iron","kindled":0.0,"chilled":2.4,"brittle":0.0,"flash":0.0,"stun":0.0,"last_band":3,"rivet_mask":0,"fray_mask":0,"clamp_state":"none","clamp_target":-1,"clamp_timer":0.0,"clamp_triggered":false})
	enemies.append({"progress":warden_progress,"hp":232.0,"max_hp":410.0,"speed":25.0,"kind":"warden","kindled":0.0,"chilled":0.0,"brittle":0.0,"flash":0.0,"stun":0.0,"last_band":4,"rivet_mask":0,"fray_mask":0,"clamp_state":"loosened","clamp_target":4,"clamp_timer":0.0,"clamp_triggered":true})
	enemies_spawned = 3
	enemies_spawned_by_role = {"coal":1,"iron":1,"warden":1}
	clamp_created = 1
	toast_message("CLAMP LOOSENED", "Ceramic collar seated  •  STRIKER BREAKS NEXT")
	toast_clock = 30.0
	add_beat("clamp_loose", route_position(warden_progress), COOL, "BELL SEATED  •  STRIKER NEXT", 30.0)
	# The persistent toast and clamp geometry already explain the response. Do
	# not retain a second label over the Warden/heart lane in the visual fixture.
	beats.clear()
	capture_hold = true

func factory_tick(tick: int) -> void:
	if factory_scenario == "capture" and tick == 0 and wave == 0:
		setup_capture_wave_fixture()
	if factory_scenario == "defeat_replay" and mode == "defeat" and restart_count == 0:
		defeat_seen = true
		reset_game(true)
		apply_factory_layout("defensive")
		next_wave_clock = 0.03
	if factory_scenario != "capture":
		execute_factory_plan()

func expected_credit_balance() -> int:
	return starting_credit_issued + fixture_credit_granted + coins_earned + coins_refunded - coins_spent - credit_abandoned_on_reset

func credit_is_conserved() -> bool:
	return coins == expected_credit_balance()

func factory_sample() -> Dictionary:
	var role_counts := {"coal":0,"iron":0,"warden":0}
	var boss_phase := "absent"
	var clamp_target := -1
	for enemy in enemies:
		role_counts[String(enemy.kind)] = int(role_counts[String(enemy.kind)])+1
		if String(enemy.kind)=="warden":
			boss_phase=String(enemy.clamp_state)
			clamp_target=int(enemy.clamp_target)
	return {
		"mode":mode,"wave_index":wave,"wave_active":wave_active,"spawn_queue":spawn_queue.size(),
		"enemies_by_role":role_counts,"boss_phase":boss_phase,"clamp_target":clamp_target,
		"coins":coins,"credit_earned":coins_earned,"credit_spent":coins_spent,"credit_refunded":coins_refunded,"net_credit_spent":coins_spent-coins_refunded,
		"fixture_credit_granted":fixture_credit_granted,"starting_credit_issued":starting_credit_issued,"credit_abandoned_on_reset":credit_abandoned_on_reset,
		"credit_expected":expected_credit_balance(),"credit_conserved":credit_is_conserved(),
		"placements":placements,"sales":sales,"masterworks":masterworks,"tower_kinds":tower_kind_counts(),
		"strategy":factory_strategy_name(),"plan_step":factory_plan_step,"plan_complete":factory_plan_complete,"factory_actions":factory_action_log.duplicate(true),
		"fuse_states":fuse_state_names(),"fuse_causes":fuse_causes.duplicate(),"max_frayed_bands":max_frayed_bands,
		"accelerated_crossings":enemies_accelerated_by_fray,"reactions":reactions_by_kind.duplicate(),
		"core_health":core_health,"core_damage":core_damage_taken,"paused":game_paused,"speed":game_speed,
		"max_enemy_progress_ratio":max_enemy_progress_ratio,"warden_max_progress_ratio":warden_max_progress_ratio,
		"wave_completion_times":wave_completion_times.duplicate(),"victory_elapsed":victory_elapsed,
		"restart_count":restart_count,"enemies":enemies.size()
	}

func factory_collect() -> Dictionary:
	var violations: Array = []
	if factory_scenario != "capture" and enemies_spawned <= 0: violations.append({"code":"emberline.no_spawn","message":"No enemies spawned.","severity":"error"})
	if factory_scenario != "capture" and enemies_moved < 60.0: violations.append({"code":"emberline.no_motion","message":"Enemies did not traverse the living fuse.","severity":"error"})
	if not finite_simulation(): violations.append({"code":"emberline.non_finite","message":"Simulation produced non-finite state.","severity":"error"})
	if factory_scenario != "capture" and fixture_credit_granted != 0: violations.append({"code":"emberline.fixture_funded","message":"A strategic acceptance run received fixture credit.","severity":"error"})
	if not credit_is_conserved(): violations.append({"code":"emberline.credit_conservation","message":"Observed credit does not match issued, earned, refunded, spent, and abandoned credit.","severity":"error"})
	if factory_scenario == "capture":
		pass
	elif factory_scenario == "defeat_replay":
		if not defeat_seen: violations.append({"code":"emberline.no_defeat","message":"Defeat path was not reached.","severity":"error"})
		if restart_count <= 0: violations.append({"code":"emberline.no_replay","message":"Replay did not reset the run.","severity":"error"})
		if not victory_seen or waves_completed < 4: violations.append({"code":"emberline.replay_incomplete","message":"The zero-subsidy replay did not complete all four waves.","severity":"error"})
		if clamp_created <= 0 or clamp_resolved <= 0: violations.append({"code":"emberline.replay_clamp","message":"The replay did not create and resolve the Warden clamp.","severity":"error"})
		if not factory_plan_complete: violations.append({"code":"emberline.replay_plan_incomplete","message":"The resource-reachable replay build did not complete.","severity":"error"})
	else:
		if shots_fired <= 0: violations.append({"code":"emberline.no_fire","message":"Instruments never fired.","severity":"error"})
		if total_reactions() <= 0: violations.append({"code":"emberline.no_reaction","message":"No thermal reaction was observed.","severity":"error"})
		if fuse_transitions <= 0: violations.append({"code":"emberline.no_fuse_transition","message":"The living fuse never changed state.","severity":"error"})
		if waves_completed < 4: violations.append({"code":"emberline.incomplete_run","message":"The four-wave run did not complete.","severity":"error"})
		if int(enemies_spawned_by_role.warden) <= 0: violations.append({"code":"emberline.no_boss","message":"The Furnace Warden was not reached.","severity":"error"})
		if clamp_created <= 0: violations.append({"code":"emberline.no_clamp","message":"The Warden clamp was not created.","severity":"error"})
		if clamp_resolved <= 0: violations.append({"code":"emberline.unresolved_clamp","message":"Bell then Striker did not resolve the clamp.","severity":"error"})
		if not victory_seen: violations.append({"code":"emberline.no_victory","message":"The resource-reachable strategy did not reach victory.","severity":"error"})
		if not factory_plan_complete: violations.append({"code":"emberline.plan_incomplete","message":"The staged paid build did not complete.","severity":"error"})
		var net_spend := coins_spent - coins_refunded
		if net_spend < 380 or net_spend > 390: violations.append({"code":"emberline.unequal_budget","message":"The strategy did not stay inside the shared 380-390 net-credit comparison budget.","severity":"error"})
		if factory_scenario == "defensive" and (int(reactions_by_kind.shatter) <= 0 or max_frayed_bands > 1 or enemies_accelerated_by_fray > 5): violations.append({"code":"emberline.no_safe_reaction","message":"The defensive plan did not preserve its low-fray Shatter identity.","severity":"error"})
		if factory_scenario == "aggressive" and (int(reactions_by_kind.flashboil) <= 0 or sales <= 0 or max_frayed_bands < 2 or enemies_accelerated_by_fray < 10): violations.append({"code":"emberline.no_aggressive_tradeoff","message":"The aggressive plan did not expose fuse heat, accelerated crossings, and a paid clamp rebuild.","severity":"error"})
	return {"metrics":{
		"enemies_spawned":enemies_spawned,"enemies_defeated":enemies_defeated,"enemies_spawned_by_role":enemies_spawned_by_role,
		"enemies_defeated_by_role":enemies_defeated_by_role,"enemy_distance":enemies_moved,"tower_shots":shots_fired,
		"reactions":total_reactions(),"reactions_by_kind":reactions_by_kind,"waves_completed":waves_completed,
		"fuse_transitions":fuse_transitions,"fuse_transition_causes":fuse_transition_causes,"max_frayed_bands":max_frayed_bands,
		"enemies_accelerated_by_fray":enemies_accelerated_by_fray,"clamp_created":clamp_created,"clamp_resolved":clamp_resolved,
		"core_health":core_health,"core_damage":core_damage_taken,"coins_earned":coins_earned,"coins_spent":coins_spent,
		"coins_refunded":coins_refunded,"net_credit_spent":coins_spent-coins_refunded,"coins_remaining":coins,
		"starting_credit_issued":starting_credit_issued,"credit_abandoned_on_reset":credit_abandoned_on_reset,
		"credit_expected":expected_credit_balance(),"credit_conserved":1 if credit_is_conserved() else 0,
		"placements":placements,"sales":sales,"masterworks":masterworks,"fixture_credit_granted":fixture_credit_granted,
		"strategy":factory_strategy_name(),"plan_complete":1 if factory_plan_complete else 0,"factory_actions":factory_action_log,
		"max_enemy_progress_ratio":max_enemy_progress_ratio,"warden_max_progress_ratio":warden_max_progress_ratio,
		"wave_completion_times":wave_completion_times,"victory_elapsed":victory_elapsed,
		"victory_reached":1 if victory_seen else 0,"defeat_reached":1 if defeat_seen else 0,"restart_count":restart_count,
		"finite_state":1 if finite_simulation() else 0
	},"violations":violations}

func tower_kind_counts() -> Dictionary:
	var counts := {"spark":0,"bell":0,"striker":0}
	for tower in towers:
		counts[String(tower.kind)] = int(counts[String(tower.kind)])+1
	return counts

func fuse_state_names() -> Array:
	var names: Array = []
	for state in fuse_states:
		names.append(["STEADY","HOT","FRAYED"][int(state)])
	return names

func finite_simulation() -> bool:
	if not is_finite(enemies_moved) or not is_finite(elapsed) or not is_finite(max_enemy_progress_ratio) or not is_finite(warden_max_progress_ratio):
		return false
	for enemy in enemies:
		if not is_finite(float(enemy.progress)) or not is_finite(float(enemy.hp)):
			return false
	return true
