extends Node2D

# KNOT THEORY -- a compact, code-native rope workshop.
# Puzzle truth is an exact reversible contact word plus current physical state:
# PASS contacts, an authored HOLD, a live TURN, SET at the cleat, and weakest-
# span LOAD.  The rope remains one freely manipulated 34-sample polyline.

const VIEW := Vector2(1152, 720)
const N := 34
const WORK_RECT := Rect2(24, 22, 1104, 674)
const PLAY_TOP := 142.0

const INK := Color("101719")
const PLATE := Color("192426")
const PLATE_DEEP := Color("111a1c")
const IRON := Color("263234")
const IRON_EDGE := Color("3b4949")
const WOOD := Color("402a1e")
const WOOD_LIGHT := Color("6f4930")
const PAPER := Color("d8c9a8")
const BONE := Color("efe3c9")
const CHALK := Color("9caead")
const FLAX := Color("d9a85c")
const FLAX_LIGHT := Color("f4cf83")
const FLAX_DARK := Color("7b512d")
const BRASS := Color("b9863f")
const BRASS_LIGHT := Color("e1b764")
const BRASS_DARK := Color("684520")
const CORAL := Color("d76452")
const GREEN := Color("91ad87")

var levels := [
	{
		"name":"TAKE UP SLACK", "mark":"01", "verb":"PULL / SET",
		"prompt":"Lead the whipped end into the open cleat.",
		"start":Vector2(135,470), "end":Vector2(610,440), "rest":30.0,
		"rest_path":[Vector2(135,470),Vector2(145,430),Vector2(165,380),Vector2(210,340),Vector2(265,325),Vector2(320,340),Vector2(365,375),Vector2(385,430),Vector2(400,485),Vector2(435,520),Vector2(485,535),Vector2(535,515),Vector2(570,480),Vector2(610,440)],
		"cleat":Vector2(970,440), "eyes":[], "expected":[],
		"cap":Vector2.ZERO, "socket":Vector2(-999,-999), "needs_hold":false
	},
	{
		"name":"THROUGH THE EYE", "mark":"02", "verb":"PASS / SET",
		"prompt":"The whipped end alone can enter the bone eye.",
		"start":Vector2(118,520), "end":Vector2(490,520), "rest":31.0,
		"rest_path":[Vector2(118,520),Vector2(130,470),Vector2(155,415),Vector2(195,365),Vector2(245,335),Vector2(300,325),Vector2(355,340),Vector2(395,375),Vector2(420,425),Vector2(440,475),Vector2(470,510),Vector2(490,520)],
		"cleat":Vector2(990,390), "eyes":[Vector2(580,390)], "expected":[[0,1]],
		"cap":Vector2.ZERO, "socket":Vector2(-999,-999), "needs_hold":false
	},
	{
		"name":"TAKE A TURN", "mark":"03", "verb":"HOLD / TURN / SET",
		"prompt":"Seat a bight in the socket, then circle with the grain.",
		"start":Vector2(125,500), "end":Vector2(515,525), "rest":45.0,
		"rest_path":[Vector2(125,500),Vector2(140,450),Vector2(170,395),Vector2(215,350),Vector2(270,328),Vector2(325,334),Vector2(372,365),Vector2(402,410),Vector2(425,458),Vector2(455,500),Vector2(515,525)],
		"cleat":Vector2(1000,495), "eyes":[], "expected":[],
		"cap":Vector2(720,390), "socket":Vector2(425,430), "needs_hold":true
	},
	{
		"name":"THE BELL HOIST", "mark":"04", "verb":"REEVE / TURN / LOAD",
		"prompt":"Reeve both eyes. Turn. Load the bell.",
		"start":Vector2(92,540), "end":Vector2(275,510), "rest":47.0,
		"rest_path":[Vector2(92,540),Vector2(110,485),Vector2(135,420),Vector2(175,360),Vector2(225,320),Vector2(275,305),Vector2(330,315),Vector2(385,340),Vector2(430,375),Vector2(470,420),Vector2(500,470),Vector2(510,515),Vector2(490,545),Vector2(450,565),Vector2(400,575),Vector2(350,565),Vector2(305,545),Vector2(275,510)],
		"cleat":Vector2(1030,535), "eyes":[Vector2(355,420),Vector2(610,272)],
		"expected":[[0,1],[1,1]], "cap":Vector2(805,410),
		"socket":Vector2(-999,-999), "needs_hold":false
	}
]

var points: Array[Vector2] = []
var started := false
var level := 0
var grabbed := -1
var hover := -1
var mouse_position := Vector2.ZERO
var docked := false
var solved := false
var solve_hold := 0.0
var contacts: Array[Dictionary] = []
var eye_entries: Dictionary = {}
var socket_index := -1
var route_signature: Array = []
var route_ok := false
var hold_ok := true
var wrap_ok := false
var dock_ok := false
var load_ok := false
var winding := 0.0
var wrap_progress := 0.0
var wrap_start := -1
var wrap_end := -1
var span_loads: Array[float] = []
var route_load := 0.0
var load_height := 0.0
var motion_time := 0.0
var grab_lift := 0.0
var reset_sweep := 0.0
var success_pulse := 0.0
var success_age := 0.0
var reject_pulse := 0.0
var reject_position := Vector2.ZERO
var reject_kind := ""
var contact_pulses: Dictionary = {}
var fibers: Array[Dictionary] = []
var audio_players: Array[AudioStreamPlayer] = []
var audio_streams: Dictionary = {}
var audio_cursor := 0
var audio_muted := false
var tension_cued := false
var display_font: FontVariation
var label_font: FontVariation

# Deterministic factory telemetry. These values only advance when observable
# production state changes; the final score is a weighted summary of them.
var factory_mode := false
var factory_ticks := 0
var factory_drag_samples := 0
var factory_path: Array[Vector2] = []
var solved_levels: Dictionary = {}
var visited_levels: Dictionary = {}
var verbs: Dictionary = {}
var transitions := 0
var goals := 0
var resets := 0
var progressions := 0
var replays := 0
var invalid_cases := 0
var max_load := 0.0
var finite_state := true
var prior_predicates := [false,false,false,false,false]
var near_misses: Dictionary = {}

func _ready() -> void:
	_build_typography()
	_build_audio()
	queue_redraw()

func _process(delta: float) -> void:
	motion_time += delta
	if started:
		if grabbed < 0 and not docked:
			_relax(3)
		_evaluate(delta)
	grab_lift = maxf(0.0, grab_lift - delta * 4.8)
	reset_sweep = maxf(0.0, reset_sweep - delta * 2.4)
	success_pulse = maxf(0.0, success_pulse - delta * .72)
	if solved:
		success_age += delta
	reject_pulse = maxf(0.0, reject_pulse - delta * 2.6)
	for key in contact_pulses.keys():
		contact_pulses[key] = maxf(0.0, float(contact_pulses[key]) - delta * 2.1)
		if contact_pulses[key] <= 0.0:
			contact_pulses.erase(key)
	for i in range(fibers.size() - 1, -1, -1):
		fibers[i].p += fibers[i].v * delta
		fibers[i].v *= .945
		fibers[i].life -= delta
		if fibers[i].life <= 0.0:
			fibers.remove_at(i)
	queue_redraw()

func _reset(count := true) -> void:
	if count:
		resets += 1
		_play_cue("reset")
	points.clear()
	contacts.clear()
	eye_entries.clear()
	contact_pulses.clear()
	socket_index = -1
	var d: Dictionary = levels[level]
	var rest_anchors: Array[Vector2] = []
	rest_anchors.assign(d.rest_path)
	points = _resample(rest_anchors,N)
	grabbed = -1
	hover = -1
	docked = false
	solved = false
	solve_hold = 0.0
	route_signature.clear()
	winding = 0.0
	wrap_progress = 0.0
	wrap_start = -1
	wrap_end = -1
	span_loads.clear()
	route_load = 0.0
	load_height = 0.0
	reset_sweep = 1.0
	reject_pulse = 0.0
	success_pulse = 0.0
	success_age = 0.0
	tension_cued = false
	prior_predicates = [false,false,false,false,false]
	_evaluate(0.0)

func _unhandled_input(event: InputEvent) -> void:
	if factory_mode:
		return
	if event is InputEventKey and event.pressed and not event.echo:
		if event.keycode == KEY_R and started:
			_reset()
		elif event.keycode == KEY_ESCAPE:
			started = false
			grabbed = -1
		elif event.keycode == KEY_M:
			audio_muted = not audio_muted
			_play_cue("pin")
		elif event.keycode == KEY_ENTER or event.keycode == KEY_SPACE:
			if not started:
				_start_game()
			elif solved:
				_advance()
	if event is InputEventMouseMotion:
		mouse_position = event.position
		hover = _nearest(event.position, 34.0)
		if grabbed >= 0 and not docked:
			_drag_to(event.position)
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		mouse_position = event.position
		if event.pressed:
			_press(event.position)
		else:
			_release(event.position)
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_RIGHT and event.pressed:
		mouse_position = event.position
		_toggle_socket(event.position)

func _start_game() -> void:
	started = true
	level = 0
	_reset(false)
	_play_cue("dock")

func _advance() -> void:
	if level == levels.size() - 1:
		level = 0
		replays += 1
	else:
		level += 1
		progressions += 1
	_reset(false)

func _press(position: Vector2) -> void:
	if not started:
		if _begin_rect().has_point(position) or _title_rope_start_rect().has_point(position):
			_start_game()
		return
	if solved and _next_rect().has_point(position):
		_advance()
		return
	if _reset_rect().has_point(position):
		_reset()
		return
	var cleat: Vector2 = levels[level].cleat
	if docked and position.distance_to(cleat) < 54.0:
		docked = false
		grabbed = N - 1
		grab_lift = 1.0
		verbs.undock = true
		_play_cue("release")
		return
	# Give the visually whipped endpoint a generous hit target, but never let a
	# nearby material sample impersonate it once dragging begins.
	grabbed = N - 1 if points[N - 1].distance_to(position) <= 52.0 else _nearest(position, 42.0)
	if grabbed >= 0:
		if grabbed == socket_index:
			grabbed = -1
			_reject(levels[level].socket, "RELEASE HOLD WITH RIGHT CLICK")
		else:
			grab_lift = 1.0
			verbs.pull = true
			_play_cue("grab")

func _release(position: Vector2) -> void:
	if grabbed == N - 1 and position.distance_to(levels[level].cleat) < 62.0:
		docked = true
		points[N - 1] = levels[level].cleat
		verbs.set = true
		contact_pulses.cleat = 1.0
		_burst(points[N - 1], 10, FLAX_LIGHT)
		_play_cue("dock")
	elif grabbed == N - 1:
		_reject(points[grabbed], "THE WHIPPED END SETS IN BRASS")
	grabbed = -1

func _drag_to(position: Vector2) -> void:
	if grabbed < 0 or docked or grabbed == socket_index:
		return
	var target := Vector2(clampf(position.x, 42.0, 1110.0), clampf(position.y, PLAY_TOP + 8.0, 672.0))
	var previous := points[grabbed]
	if grabbed == N - 1:
		_track_passes(previous, target)
	points[grabbed] = target
	_relax(12)
	verbs.pull = true

func _track_passes(previous: Vector2, current: Vector2) -> void:
	# Only the marked working end changes topology. An eye keeps a temporary
	# entry side while the end is inside its aperture; leaving through the
	# opposite side creates a signed PASS. Traversing back pops that contact.
	var eyes: Array = levels[level].eyes
	for eye_index in range(eyes.size()):
		var center := _eye_position(eye_index)
		var was_inside := previous.distance_to(center) <= 30.0
		var is_inside := current.distance_to(center) <= 30.0
		var previous_side := -1 if previous.x < center.x else 1
		var current_side := -1 if current.x < center.x else 1
		if not eye_entries.has(eye_index) and not was_inside and is_inside:
			eye_entries[eye_index] = previous_side
		elif eye_entries.has(eye_index) and was_inside and not is_inside:
			var entry_side := int(eye_entries[eye_index])
			eye_entries.erase(eye_index)
			if entry_side != current_side and absf(current.y - center.y) < 30.0:
				_apply_pass(eye_index, 1 if entry_side < current_side else -1)
			else:
				_reject(center, "ENTER AND LEAVE OPPOSITE SIDES")
		elif not eye_entries.has(eye_index) and not was_inside and not is_inside:
			# Large input samples may cross the full aperture in one frame.
			if previous_side != current_side and _segment_distance(center, previous, current) < 20.0:
				_apply_pass(eye_index, 1 if previous_side < current_side else -1)

func _apply_pass(eye_index: int, sense: int) -> void:
	var center := _eye_position(eye_index)
	if not contacts.is_empty():
		var last: Dictionary = contacts[-1]
		if int(last.eye) == eye_index and int(last.sense) == -sense:
			contacts.pop_back()
			verbs.unthread = true
			contact_pulses["eye_%d" % eye_index] = 1.0
			_burst(center, 8, BONE)
			_play_cue("release")
			return
	var point_index := _authored_contact_point(eye_index)
	contacts.append({"eye":eye_index, "sense":sense, "point":point_index})
	verbs.pass = true
	contact_pulses["eye_%d" % eye_index] = 1.0
	_burst(center, 10, BONE)
	_play_cue("pass")

func _authored_contact_point(eye_index: int) -> int:
	# A PASS captures the material sample whose rest-length distance from the
	# bitter end reaches this fixture. This avoids turning a newly crossed eye
	# into a near-end pin and preserves usable rope on both authored spans.
	var distance := 0.0
	var previous: Vector2 = levels[level].start
	for i in range(eye_index + 1):
		var eye := _eye_position(i)
		distance += previous.distance_to(eye)
		previous = eye
	var preferred := clampi(int(round(distance/_segment_length())),1,N-2)
	var used: Dictionary = {}
	for contact in contacts:
		used[int(contact.point)] = true
	while used.has(preferred) and preferred < N-2:
		preferred += 1
	return preferred

func _toggle_socket(position: Vector2) -> void:
	if not started or solved:
		return
	var socket: Vector2 = levels[level].socket
	if socket.x < 0.0:
		_reject(position, "HOLDS LIVE ONLY IN BRASS SOCKETS")
		return
	if socket_index >= 0:
		if position.distance_to(socket) <= 48.0 or _nearest(position, 32.0) == socket_index:
			socket_index = -1
			verbs.unhold = true
			contact_pulses.socket = 1.0
			_play_cue("release")
		return
	var index := _nearest(position, 44.0)
	if index <= 0 or index >= N - 1 or points[index].distance_to(socket) > 46.0:
		_reject(socket, "SEAT A ROPE BIGHT IN THIS SOCKET")
		return
	socket_index = index
	points[index] = socket
	verbs.hold = true
	contact_pulses.socket = 1.0
	_burst(socket, 9, BRASS_LIGHT)
	_play_cue("pin")

func _nearest(position: Vector2, radius: float) -> int:
	var best := -1
	var distance := radius
	for i in range(points.size()):
		var candidate := points[i].distance_to(position)
		if candidate < distance:
			best = i
			distance = candidate
	return best

func _relax(iterations: int) -> void:
	if points.size() < 2:
		return
	for iteration in range(iterations):
		points[0] = levels[level].start
		if docked:
			points[N - 1] = levels[level].cleat
		for i in range(N - 1):
			var delta := points[i + 1] - points[i]
			var distance := maxf(delta.length(), .001)
			var excess := maxf(distance - _segment_length(), 0.0)
			var correction := delta * (excess / distance) * .52
			if i != 0 and i != grabbed and not _point_locked(i):
				points[i] += correction
			if i + 1 != grabbed and not _point_locked(i + 1) and not (docked and i + 1 == N - 1):
				points[i + 1] -= correction
		_resolve_capstan_collision()
		_apply_contact_locks()

func _point_locked(index: int) -> bool:
	if index == socket_index:
		return true
	for contact in contacts:
		if int(contact.point) == index:
			return true
	return false

func _apply_contact_locks() -> void:
	if socket_index >= 0:
		points[socket_index] = levels[level].socket
	for contact in contacts:
		var eye_index := int(contact.eye)
		var point_index := int(contact.point)
		if point_index > 0 and point_index < N - 1 and eye_index < levels[level].eyes.size():
			points[point_index] = _eye_position(eye_index)

func _resolve_capstan_collision() -> void:
	var cap: Vector2 = levels[level].cap
	if cap == Vector2.ZERO:
		return
	for i in range(1, N - 1):
		if i == grabbed or _point_locked(i):
			continue
		var radial := points[i] - cap
		if radial.length() < 62.0:
			if radial.length_squared() < .001:
				radial = Vector2.RIGHT
			points[i] = cap + radial.normalized() * 62.0

func _segment_length() -> float:
	return float(levels[level].rest)

func _evaluate(delta: float) -> void:
	finite_state = true
	for point in points:
		if not is_finite(point.x) or not is_finite(point.y):
			finite_state = false
	route_ok = _route_matches_exactly()
	hold_ok = socket_index >= 0 or not bool(levels[level].needs_hold)
	wrap_ok = _compute_live_wrap()
	dock_ok = docked
	route_load = _compute_route_load()
	load_ok = route_load >= .70
	var predicates := [route_ok, hold_ok, wrap_ok, dock_ok, load_ok]
	for i in range(predicates.size()):
		if bool(predicates[i]) != bool(prior_predicates[i]):
			transitions += 1
			if bool(predicates[i]):
				if i == 0 and not levels[level].expected.is_empty():
					verbs.pass = true
				elif i == 1 and bool(levels[level].needs_hold):
					verbs.hold = true
				elif i == 2 and levels[level].cap != Vector2.ZERO:
					verbs.turn = true
				elif i == 3:
					verbs.set = true
				elif i == 4:
					verbs.load = true
		prior_predicates[i] = predicates[i]
	if load_ok and not tension_cued:
		tension_cued = true
		verbs.load = true
		_play_cue("tension")
	elif route_load < .42:
		tension_cued = false
	visited_levels[level] = true
	var prereq := route_ok and hold_ok and wrap_ok
	var machine_target := route_load if prereq else 0.0
	load_height = move_toward(load_height, machine_target, delta * (1.45 if level == 3 else 2.2))
	if level == 3:
		max_load = maxf(max_load, load_height)
	var goal := prereq and docked and load_ok and (level < 3 or load_height >= .68)
	if goal and not solved:
		solve_hold += delta
		if solve_hold >= .38:
			_solve()
	elif not solved:
		solve_hold = maxf(0.0, solve_hold - delta * 3.0)

func _route_matches_exactly() -> bool:
	route_signature.clear()
	for contact in contacts:
		route_signature.append([int(contact.eye), int(contact.sense)])
	var expected: Array = levels[level].expected
	if contacts.size() != expected.size():
		return false
	for i in range(expected.size()):
		if int(contacts[i].eye) != int(expected[i][0]) or int(contacts[i].sense) != int(expected[i][1]):
			return false
	return true

func _compute_live_wrap() -> bool:
	var cap: Vector2 = levels[level].cap
	if cap == Vector2.ZERO:
		winding = 0.0
		wrap_progress = 1.0
		wrap_start = -1
		wrap_end = -1
		return true
	var run_winding := 0.0
	var run_start := -1
	var run_segments := 0
	var best_positive := 0.0
	var best_negative := 0.0
	var best_start := -1
	var best_end := -1
	# TURN is not an independent anywhere-on-the-rope predicate. Material runs
	# before the last authored PASS/HOLD belong to an earlier route span and
	# cannot satisfy the taught PASS/HOLD -> TURN -> SET word.
	var first_segment := _turn_material_start()
	for i in range(first_segment, N - 1):
		var a := points[i] - cap
		var b := points[i + 1] - cap
		var in_annulus := a.length() >= 60.0 and a.length() <= 120.0 and b.length() >= 60.0 and b.length() <= 120.0
		if in_annulus:
			if run_start < 0:
				run_start = i
			run_winding += wrapf(b.angle() - a.angle(), -PI, PI)
			run_segments += 1
		else:
			if run_segments >= 5:
				if run_winding > best_positive:
					best_positive = run_winding
					best_start = run_start
					best_end = i
				best_negative = minf(best_negative, run_winding)
			run_winding = 0.0
			run_start = -1
			run_segments = 0
	if run_segments >= 5:
		if run_winding > best_positive:
			best_positive = run_winding
			best_start = run_start
			best_end = N - 1
		best_negative = minf(best_negative, run_winding)
	winding = best_positive if absf(best_positive) >= absf(best_negative) else best_negative
	wrap_progress = clampf(best_positive / (TAU * .82), 0.0, 1.0)
	wrap_start = best_start
	wrap_end = best_end
	if best_negative <= -TAU * .45 and reject_pulse <= 0.0 and grabbed >= 0:
		_reject(cap, "TURN WITH THE ENGRAVED ARROWS")
	return best_positive >= TAU * .82 and best_start >= 0 and best_end - best_start >= 7

func _turn_material_start() -> int:
	var boundary := 0
	for contact in contacts:
		boundary = maxi(boundary, int(contact.point))
	if socket_index >= 0:
		boundary = maxi(boundary, socket_index)
	return clampi(boundary, 0, N - 2)

func _compute_route_load() -> float:
	span_loads.clear()
	if points.size() < 2:
		return 0.0
	var anchors: Array[int] = [0]
	for contact in contacts:
		anchors.append(int(contact.point))
	if socket_index >= 0:
		anchors.append(socket_index)
	if wrap_start >= 0:
		anchors.append(wrap_start)
	if wrap_end >= 0:
		anchors.append(wrap_end)
	anchors.append(N - 1)
	anchors.sort()
	var unique: Array[int] = []
	for anchor in anchors:
		if unique.is_empty() or int(unique[-1]) != anchor:
			unique.append(anchor)
	var weakest := 1.0
	for span in range(unique.size() - 1):
		var a := int(unique[span])
		var b := int(unique[span + 1])
		if b <= a:
			continue
		var path := 0.0
		for i in range(a, b):
			path += points[i].distance_to(points[i + 1])
		var rest := _segment_length() * float(b - a)
		var extension := clampf(path / maxf(rest, 1.0), 0.0, 1.0)
		var directness := clampf(points[a].distance_to(points[b]) / maxf(path, 1.0), 0.0, 1.0)
		# Aggregate extension alone lets a violently stretched tail compensate for
		# compressed upstream material. The lowest local quartile makes LOAD fail
		# closed wherever slack actually remains inside an authored span.
		var local_extensions: Array[float] = []
		for i in range(a,b):
			local_extensions.append(clampf(points[i].distance_to(points[i+1])/_segment_length(),0.0,1.0))
		local_extensions.sort()
		var low_count := maxi(1,int(ceil(float(local_extensions.size())*.25)))
		var low_mean := 0.0
		for i in range(low_count):
			low_mean += local_extensions[i]
		low_mean /= float(low_count)
		var local_support := smoothstep(.24,.58,low_mean)
		var taut := minf(smoothstep(.66, .91, extension) * lerpf(.82, 1.0, directness),local_support)
		span_loads.append(taut)
		weakest = minf(weakest, taut)
	return weakest if not span_loads.is_empty() else 0.0

func _eye_position(eye_index: int) -> Vector2:
	var position: Vector2 = levels[level].eyes[eye_index]
	# The lower hoist block is kinematic, bounded, and driven by live route load.
	if level == 3 and eye_index == 0:
		position.y -= load_height * 52.0
	return position

func _segment_distance(position: Vector2, a: Vector2, b: Vector2) -> float:
	var ab := b - a
	if ab.length_squared() < .001:
		return position.distance_to(a)
	return position.distance_to(a + ab * clampf((position - a).dot(ab) / ab.length_squared(), 0.0, 1.0))

func _solve() -> void:
	solved = true
	goals += 1
	solved_levels[level] = true
	success_pulse = 1.0
	success_age = 0.0
	verbs.load = true
	_burst(levels[level].cleat, 26, FLAX_LIGHT)
	_play_cue("bell" if level == 3 else "success")

func _reject(position: Vector2, message: String) -> void:
	reject_position = position
	reject_kind = message
	reject_pulse = 1.0
	_burst(position, 5, CORAL)
	_play_cue("reject")

# ---------------------------------------------------------------------------
# Sparse synthesized physical audio

func _build_audio() -> void:
	for i in range(4):
		var player := AudioStreamPlayer.new()
		player.volume_db = -9.0
		add_child(player)
		audio_players.append(player)
	var specs := {
		"grab":{"notes":[105.0,157.5],"duration":.065,"noise":.16},
		"dock":{"notes":[390.0,585.0],"duration":.12,"noise":.05},
		"release":{"notes":[220.0],"duration":.085,"noise":.12},
		"pass":{"notes":[285.0,427.5],"duration":.13,"noise":.07},
		"pin":{"notes":[330.0,495.0],"duration":.095,"noise":.08},
		"reject":{"notes":[92.0],"duration":.11,"noise":.24},
		"tension":{"notes":[174.0,261.0],"duration":.19,"noise":.035},
		"reset":{"notes":[145.0],"duration":.11,"noise":.16},
		"success":{"notes":[220.0,275.0,330.0],"duration":.48,"noise":.012},
		"bell":{"notes":[392.0,784.0,1176.0],"duration":.82,"noise":.008}
	}
	for cue in specs:
		var spec: Dictionary = specs[cue]
		audio_streams[cue] = _synth_stream(spec.notes, float(spec.duration), float(spec.noise))

func _play_cue(kind: String) -> void:
	if audio_players.is_empty() or factory_mode or audio_muted or not audio_streams.has(kind):
		return
	var player := audio_players[audio_cursor % audio_players.size()]
	audio_cursor += 1
	player.stream = audio_streams[kind]
	player.play()

func _synth_stream(frequencies: Array, duration: float, noise: float) -> AudioStreamWAV:
	var rate := 22050
	var frames := int(duration * rate)
	var pcm := PackedByteArray()
	pcm.resize(frames * 2)
	for i in range(frames):
		var t := float(i) / rate
		var envelope := pow(1.0 - float(i) / frames, 2.2) * minf(1.0, t / .012)
		var value := 0.0
		for frequency in frequencies:
			value += sin(TAU * float(frequency) * t) / frequencies.size()
		value += sin(float(i * i % 997) * .37) * noise
		pcm.encode_s16(i * 2, int(clampf(value * envelope, -1.0, 1.0) * 24500.0))
	var stream := AudioStreamWAV.new()
	stream.format = AudioStreamWAV.FORMAT_16_BITS
	stream.mix_rate = rate
	stream.stereo = false
	stream.data = pcm
	return stream

func _burst(origin: Vector2, count: int, color: Color) -> void:
	for i in range(count):
		fibers.append({
			"p":origin,
			"v":Vector2.from_angle(float(i) * 2.399) * float(28 + (i % 6) * 10),
			"life":.62,
			"color":color
		})

# ---------------------------------------------------------------------------
# Authored code-native workshop rendering

func _build_typography() -> void:
	# Two code-native cuts replace the single default-font voice without taking
	# a platform font dependency: a broad, ink-heavy display stamp and a tight,
	# tracked field-label cut.
	display_font = FontVariation.new()
	display_font.base_font = ThemeDB.fallback_font
	display_font.variation_embolden = 1.15
	display_font.spacing_glyph = 1
	label_font = FontVariation.new()
	label_font.base_font = ThemeDB.fallback_font
	label_font.variation_embolden = .18
	label_font.spacing_glyph = 1

func _draw() -> void:
	_draw_workshop_shell()
	if not started:
		_draw_title()
		return
	_draw_level_header()
	_draw_machine_bed()
	_draw_machine()
	_draw_fixture_backs()
	_draw_rope()
	_draw_crossing_clarity()
	_draw_fixture_foregrounds()
	_draw_status_ledger()
	_draw_feedback()

func _font() -> Font:
	return label_font if label_font != null else ThemeDB.fallback_font

func _display_font() -> Font:
	return display_font if display_font != null else _font()

func _draw_workshop_shell() -> void:
	draw_rect(Rect2(Vector2.ZERO, VIEW), Color("1b120e"))
	draw_rect(WORK_RECT, Color("24150f"))
	draw_rect(WORK_RECT.grow(-5), WOOD)
	# Joined, hand-rubbed timber with broad grain and a few quiet knots.
	for seam_x in [286.0,566.0,846.0]:
		draw_line(Vector2(seam_x,27),Vector2(seam_x+3,691),Color("24150f",.72),3.0,true)
		draw_line(Vector2(seam_x+4,28),Vector2(seam_x+6,690),Color(WOOD_LIGHT,.18),1.0,true)
	for i in range(18):
		var y := 27.0 + float(i) * 37.0
		var bow := sin(float(i) * 1.71) * 7.0
		draw_polyline(PackedVector2Array([Vector2(29,y),Vector2(270,y+bow),Vector2(560,y-bow*.4),Vector2(845,y+bow*.7),Vector2(1124,y-bow*.2)]),Color(WOOD_LIGHT,.22 if i%3 else .34),1.5 if i%3 else 2.0,true)
	for knot in [Vector2(183,32),Vector2(966,686),Vector2(35,348)]:
		draw_arc(knot,15,-2.7,2.7,24,Color("1d100c",.62),4,true)
		draw_arc(knot,9,-2.5,2.5,20,Color(WOOD_LIGHT,.30),2,true)
	for x in [31.0,1121.0]:
		draw_line(Vector2(x,34),Vector2(x,688),Color("1e130f"),8.0)
	draw_rect(Rect2(38,36,1076,646), Color(0,0,0,.46))
	draw_rect(Rect2(42,40,1068,638), PLATE)
	draw_rect(Rect2(46,44,1060,630), Color("0c1112"), false, 3.0)
	draw_rect(Rect2(50,48,1052,622), Color("344043",.82), false, 1.0)
	# Hand-rubbed slate variation and a consistent top-left light.
	draw_colored_polygon(PackedVector2Array([Vector2(46,44),Vector2(760,44),Vector2(430,672),Vector2(46,672)]),Color(1.0,.92,.72,.018))
	for i in range(24):
		var center := Vector2(86 + (i * 173) % 982, 78 + (i * 97) % 560)
		var scratch := Vector2(14+(i%5)*7,sin(float(i)*2.3)*8)
		draw_line(center-scratch*.5,center+scratch*.5,Color(CHALK,.035 if i%4 else .07),1.0,true)
	for i in range(12):
		var center := Vector2(118 + (i * 137) % 900, 176 + (i * 83) % 410)
		draw_arc(center, 28 + (i % 4) * 17, -.8, 1.75, 18, Color(CHALK,.045), 1.0, true)
	for corner in [Vector2(48,46),Vector2(1104,46),Vector2(48,672),Vector2(1104,672)]:
		_draw_bolt(corner)

func _draw_bolt(position: Vector2) -> void:
	draw_circle(position + Vector2(2,3), 8.0, Color(0,0,0,.5))
	draw_circle(position, 7.0, BRASS_DARK)
	draw_circle(position - Vector2(1.5,1.5), 4.5, BRASS)
	draw_line(position + Vector2(-3,1), position + Vector2(3,-1), Color("4a301b"), 1.5, true)

func _draw_title() -> void:
	# Paper maker's label, set into the plate rather than floating as UI chrome.
	_draw_paper_ticket(Rect2(72,72,510,178),true)
	draw_string(_font(),Vector2(102,121),"THE WORKSHOP STUDIES",HORIZONTAL_ALIGNMENT_LEFT,420,14,Color("55452f"))
	draw_string(_display_font(),Vector2(96,184),"KNOT",HORIZONTAL_ALIGNMENT_LEFT,430,56,INK)
	draw_string(_display_font(),Vector2(96,230),"THEORY",HORIZONTAL_ALIGNMENT_LEFT,430,47,INK)
	draw_string(_font(),Vector2(606,102),"FIELD INSTRUMENT  /  NO. 04",HORIZONTAL_ALIGNMENT_LEFT,430,13,BRASS_LIGHT)
	# The promise is one continuous rope: fixed eye -> figure eight -> start latch.
	var emblem := PackedVector2Array()
	for i in range(65):
		var t := float(i) / 64.0 * TAU
		emblem.append(Vector2(490 + sin(t) * 195, 420 + sin(t * 2.0) * 105))
	emblem.append(Vector2(515,452))
	emblem.append(Vector2(536,498))
	emblem.append(Vector2(558,548))
	emblem.append(Vector2(576,577))
	emblem.append(Vector2(615,580))
	emblem.append(Vector2(656,572))
	emblem.append(Vector2(702,554))
	emblem.append(Vector2(748,530))
	emblem.append(Vector2(792,513))
	emblem.append(Vector2(840,508))
	emblem.append(Vector2(887,512))
	_draw_rope_path(emblem, 13.0, false)
	_draw_eye(Vector2(490,420), false, 1.0, false)
	draw_string(_font(),Vector2(94,608),"ONE ROPE  /  FOUR LESSONS  /  ONE MACHINE",HORIZONTAL_ALIGNMENT_LEFT,600,17,BONE)
	_draw_world_button(_begin_rect(),"BEGIN STUDY",true)
	draw_string(_font(),Vector2(92,650),"DRAG THE ROPE     RIGHT CLICK BRASS SOCKETS     R RESET     M SOUND",HORIZONTAL_ALIGNMENT_LEFT,760,12,CHALK)
	draw_string(_font(),Vector2(905,650),"ENTER / SPACE",HORIZONTAL_ALIGNMENT_CENTER,150,11,BRASS_LIGHT)

func _draw_level_header() -> void:
	var d: Dictionary = levels[level]
	# A compact clipped field ticket leaves the bay—and its rope—as the hero.
	_draw_paper_ticket(Rect2(66,60,642,76),false)
	draw_string(_font(),Vector2(91,86),"STUDY %s / 04" % d.mark,HORIZONTAL_ALIGNMENT_LEFT,122,11,Color("6a5130"))
	draw_string(_font(),Vector2(210,86),d.verb,HORIZONTAL_ALIGNMENT_LEFT,225,11,Color("6c4a25"))
	draw_string(_display_font(),Vector2(91,120),"THE LINE HOLDS" if solved else d.name,HORIZONTAL_ALIGNMENT_LEFT,330,25,INK)
	draw_string(_font(),Vector2(345,111),"CONTACTS LIVE — PULL BACK TO UNDO" if solved else d.prompt,HORIZONTAL_ALIGNMENT_LEFT,340,13,Color("4a504b"))
	for i in range(4):
		var p := Vector2(750 + i * 36,82)
		draw_circle(p+Vector2(2,3),10,Color(0,0,0,.35))
		draw_circle(p,9,BRASS_LIGHT if i <= level else BRASS_DARK)
		if i < level:
			draw_line(p+Vector2(-4,0),p+Vector2(-1,4),INK,2,true)
			draw_line(p+Vector2(-1,4),p+Vector2(5,-4),INK,2,true)
	if solved:
		_draw_world_button(_next_rect(),"REPLAY" if level == 3 else "NEXT STUDY",true)
	else:
		_draw_world_button(_reset_rect(),"RESET  R",false)

func _draw_paper_ticket(rect: Rect2, large: bool) -> void:
	var cut := 11.0 if large else 8.0
	var shadow_points := PackedVector2Array([
		rect.position+Vector2(6,8),rect.position+Vector2(rect.size.x-cut+6,8),rect.position+Vector2(rect.size.x+6,cut+8),
		rect.position+rect.size+Vector2(6,8)-Vector2(cut,0),rect.position+rect.size+Vector2(6,8)-Vector2(rect.size.x-cut,0),rect.position+Vector2(6,rect.size.y-cut+8)])
	draw_colored_polygon(shadow_points,Color(0,0,0,.34))
	var paper_points := PackedVector2Array([
		rect.position,rect.position+Vector2(rect.size.x-cut,0),rect.position+Vector2(rect.size.x,cut),
		rect.position+rect.size-Vector2(0,cut),rect.position+rect.size-Vector2(cut,0),rect.position+Vector2(cut,rect.size.y),rect.position+Vector2(0,rect.size.y-cut)])
	draw_colored_polygon(paper_points,PAPER)
	# Fibers, ruled edge, and a stamped coral registration wedge.
	for i in range(8 if large else 5):
		var y := rect.position.y+11.0+float(i)*((rect.size.y-20.0)/(7.0 if large else 4.0))
		draw_line(Vector2(rect.position.x+13,y),Vector2(rect.end.x-15,y+sin(float(i)*1.9)*2.0),Color("806f50",.08),1.0,true)
	draw_polyline(PackedVector2Array([rect.position+Vector2(10,10),Vector2(rect.end.x-16,rect.position.y+10),rect.end-Vector2(10,10),Vector2(rect.position.x+10,rect.end.y-10)]),Color("9f8d69",.55),1.5,true)
	if large:
		draw_colored_polygon(PackedVector2Array([Vector2(rect.end.x-34,rect.position.y+12),Vector2(rect.end.x-12,rect.position.y+12),Vector2(rect.end.x-12,rect.position.y+34)]),Color(CORAL,.72))

func _draw_machine_bed() -> void:
	# A shallow recessed work bay unifies every fixture spatially.
	draw_rect(Rect2(68,164,1016,442),Color(0,0,0,.36))
	draw_rect(Rect2(72,160,1008,442),PLATE_DEEP)
	draw_rect(Rect2(78,166,996,430),Color("415052",.72),false,2.0)
	draw_line(Vector2(80,169),Vector2(1072,169),Color("697677",.20),2,true)
	for i in range(13):
		var p := Vector2(98+(i*211)%930,190+(i*73)%376)
		draw_circle(p,1.5,Color(CHALK,.08))
	# Sparse chalk routes teach through place and direction, not paragraphs.
	var d: Dictionary = levels[level]
	if not d.eyes.is_empty():
		for i in range(d.eyes.size()):
			var eye := _eye_position(i)
			draw_line(eye+Vector2(-73,0),eye+Vector2(-52,0),Color(CHALK,.45),2,true)
			_draw_chevron(eye+Vector2(-58,0),Vector2.RIGHT,Color(CHALK,.65))
	if d.cap != Vector2.ZERO:
		draw_arc(d.cap,92,-2.6,2.95,44,Color(CHALK,.20),2,true)
		for angle in [-2.1,-.65,.82,2.27]:
			_draw_chevron(d.cap+Vector2.from_angle(angle)*92,Vector2.from_angle(angle+PI/2),Color(CHALK,.55))

func _draw_machine() -> void:
	if level == 0:
		_draw_tension_gauge(Vector2(500,255),route_load)
		draw_string(_font(),Vector2(369,318),"SLACK  →  LOAD",HORIZONTAL_ALIGNMENT_CENTER,262,11,Color(CHALK,.65))
		# A restrained projected line makes the open cleat the spatial answer while
		# remaining visibly chalk, never a second rope or a solved silhouette.
		if not docked and points.size() == N:
			var from := points[N-1]+Vector2(24,0)
			var to: Vector2 = levels[level].cleat-Vector2(62,0)
			for i in range(6):
				var a := from.lerp(to,float(i)/6.0)
				var b := from.lerp(to,(float(i)+.45)/6.0)
				draw_line(a,b,Color(CHALK,.18+.05*sin(motion_time*3.0+float(i))),2,true)
			_draw_chevron(to-Vector2(8,0),Vector2.RIGHT,Color(BRASS_LIGHT,.75))
	elif level == 1:
		# The eye's contact lifts a physical shutter immediately.
		draw_rect(Rect2(505,204,100,110),Color(0,0,0,.40))
		draw_rect(Rect2(513,212,84,94),IRON)
		var shutter_y := lerpf(244,214,1.0 if route_ok else 0.0)
		for i in range(4):
			draw_rect(Rect2(521,shutter_y+i*15,68,10),WOOD_LIGHT)
		draw_line(Vector2(555,304),Vector2(555,346),BRASS_DARK,3,true)
		draw_string(_font(),Vector2(490,329),"CONTACT SHUTTER",HORIZONTAL_ALIGNMENT_CENTER,130,11,CHALK)
	elif level == 2:
		# HOLD steadies the carriage; TURN advances it along the rail.
		draw_line(Vector2(383,278),Vector2(835,278),Color(0,0,0,.5),18,true)
		draw_line(Vector2(383,274),Vector2(835,274),IRON_EDGE,8,true)
		var carriage_x := lerpf(420,690,wrap_progress if hold_ok else 0.0)
		draw_rect(Rect2(carriage_x-34,244,68,58),Color(0,0,0,.4))
		draw_rect(Rect2(carriage_x-38,238,68,58),BRASS_DARK)
		draw_rect(Rect2(carriage_x-29,247,50,40),WOOD_LIGHT)
		draw_string(_font(),Vector2(514,222),"HOLD STEADIES  /  TURN DRIVES",HORIZONTAL_ALIGNMENT_CENTER,260,12,CHALK)
	else:
		_draw_hoist_machine()

func _draw_hoist_machine() -> void:
	# Eyes, rail, capstan, shutter, and bell share one iron backbone so the
	# finale reads as a causal machine rather than a collection of icons.
	var backbone := PackedVector2Array([Vector2(310,470),Vector2(310,228),Vector2(660,228),Vector2(860,332),Vector2(1014,332)])
	draw_polyline(backbone,Color(0,0,0,.48),28,true)
	draw_polyline(backbone,IRON,18,true)
	draw_polyline(backbone,Color("596566",.23),4,true)
	for bracket in [Vector2(310,288),Vector2(660,228),Vector2(860,332)]:
		draw_circle(bracket,10,Color(0,0,0,.45))
		draw_circle(bracket-Vector2(2,2),7,IRON_EDGE)
		draw_line(bracket+Vector2(-3,1),bracket+Vector2(3,-1),Color(CHALK,.28),1.5,true)
	draw_line(Vector2(330,478),Vector2(330,318),IRON_EDGE,8,true)
	draw_line(Vector2(380,478),Vector2(380,318),IRON_EDGE,8,true)
	var block_y := _eye_position(0).y
	draw_rect(Rect2(315,block_y-42,105,84),Color(0,0,0,.34))
	draw_rect(Rect2(309,block_y-48,105,84),BRASS_DARK)
	draw_rect(Rect2(319,block_y-38,85,64),IRON)
	# Shutter travel follows the weakest loaded span.
	var shutter_y := lerpf(294,205,load_height)
	draw_rect(Rect2(886,192,108,144),Color(0,0,0,.48))
	draw_rect(Rect2(894,200,92,128),IRON)
	for i in range(5):
		draw_rect(Rect2(902,shutter_y+i*19,76,13),WOOD_LIGHT)
		draw_line(Vector2(940,185),Vector2(940,217),BRASS,4,true)
	_draw_bell(Vector2(1014,279),load_height)
	draw_string(_font(),Vector2(812,356),"LOAD TRAVELS TO THE BELL",HORIZONTAL_ALIGNMENT_CENTER,260,11,CHALK)

func _draw_bell(position: Vector2, amount: float) -> void:
	var swing := sin(motion_time * 11.0) * amount * 8.0
	draw_set_transform(position,swing * .008,Vector2.ONE)
	draw_line(Vector2(0,-50),Vector2(0,-25),BRASS_DARK,5,true)
	draw_arc(Vector2.ZERO,32,PI,TAU,28,Color(0,0,0,.45),16,true)
	draw_arc(Vector2(-3,-3),31,PI,TAU,28,BRASS,14,true)
	draw_line(Vector2(-34,0),Vector2(34,0),BRASS_LIGHT,7,true)
	draw_circle(Vector2(0,14),7,BRASS_LIGHT)
	draw_set_transform(Vector2.ZERO,0.0,Vector2.ONE)
	if solved or amount > .72:
		for ray in range(7):
			var direction := Vector2.from_angle(-2.7 + ray * .28)
			draw_line(position+direction*44,position+direction*(54+success_pulse*16),Color(FLAX_LIGHT,.7),2,true)

func _draw_tension_gauge(position: Vector2, amount: float) -> void:
	draw_circle(position+Vector2(5,7),58,Color(0,0,0,.38))
	draw_circle(position,56,IRON)
	draw_circle(position,45,PAPER)
	draw_arc(position,35,PI*.15,PI*.85,24,Color("6d6657"),3,true)
	var angle := lerpf(PI*.85,PI*.15,amount)
	draw_line(position,position+Vector2.from_angle(angle)*31,BRASS_DARK,4,true)
	draw_circle(position,7,BRASS)
	draw_string(_font(),position+Vector2(-25,26),"LOAD",HORIZONTAL_ALIGNMENT_CENTER,50,10,INK)

func _draw_fixture_backs() -> void:
	var d: Dictionary = levels[level]
	_draw_start_anchor(d.start)
	for eye_index in range(d.eyes.size()):
		_draw_eye(_eye_position(eye_index), _contact_for_eye(eye_index), float(contact_pulses.get("eye_%d" % eye_index,0.0)), true)
	if d.cap != Vector2.ZERO:
		_draw_capstan(d.cap)
	if d.socket.x >= 0.0:
		_draw_socket(d.socket)
	_draw_cleat(d.cleat,false)

func _draw_start_anchor(position: Vector2) -> void:
	draw_circle(position+Vector2(5,7),25,Color(0,0,0,.42))
	draw_circle(position,24,IRON)
	draw_circle(position,16,BRASS_DARK)
	draw_circle(position-Vector2(2,2),9,BRASS_LIGHT)
	draw_circle(position,4,INK)
	draw_string(_font(),position+Vector2(-37,45),"BITTER END",HORIZONTAL_ALIGNMENT_CENTER,74,10,CHALK)

func _draw_eye(position: Vector2, active: bool, pulse_amount: float, label: bool) -> void:
	draw_circle(position+Vector2(6,8),53,Color(0,0,0,.42))
	draw_circle(position,51,IRON)
	draw_circle(position-Vector2(2,2),43,BRASS_LIGHT if active else BRASS_DARK)
	draw_circle(position,35,BONE)
	draw_circle(position+Vector2(1,2),24,PLATE_DEEP)
	draw_arc(position-Vector2(2,2),34,-2.7,-.45,18,Color(1,1,.88,.46),4,true)
	if pulse_amount > 0.0:
		draw_arc(position,54+(1.0-pulse_amount)*22,0,TAU,40,Color(BONE,pulse_amount*.7),3,true)
	if label:
		draw_string(_font(),position+Vector2(-44,70),"PASS",HORIZONTAL_ALIGNMENT_CENTER,88,10,BONE if active else CHALK)

func _draw_capstan(position: Vector2) -> void:
	draw_circle(position+Vector2(8,10),70,Color(0,0,0,.44))
	draw_circle(position,68,IRON)
	draw_circle(position,59,BRASS_DARK)
	for spoke in range(6):
		var direction := Vector2.from_angle(float(spoke)*TAU/6.0)
		draw_line(position+direction*17,position+direction*49,BRASS,8,true)
	draw_circle(position,42,Color("765026"))
	draw_circle(position-Vector2(3,3),30,BRASS)
	draw_circle(position,13,INK)
	draw_arc(position,83,-PI*.82,-PI*.82+TAU*wrap_progress,46,BRASS_LIGHT if winding>=0 else CORAL,5,true)
	draw_string(_font(),position+Vector2(-46,100),"LIVE TURN",HORIZONTAL_ALIGNMENT_CENTER,92,10,BONE if wrap_ok else CHALK)

func _draw_socket(position: Vector2) -> void:
	draw_circle(position+Vector2(5,7),31,Color(0,0,0,.4))
	draw_circle(position,30,IRON)
	draw_circle(position,22,BRASS_DARK)
	draw_circle(position,13,PLATE_DEEP if socket_index < 0 else BRASS_LIGHT)
	draw_line(position+Vector2(-8,0),position+Vector2(8,0),BONE if socket_index>=0 else CHALK,3,true)
	var pulse_amount := float(contact_pulses.get("socket",0.0))
	if pulse_amount > 0.0:
		draw_arc(position,34+(1.0-pulse_amount)*20,0,TAU,32,Color(BRASS_LIGHT,pulse_amount),3,true)
	draw_string(_font(),position+Vector2(-48,50),"RIGHT CLICK HOLD",HORIZONTAL_ALIGNMENT_CENTER,96,10,BONE if socket_index>=0 else CHALK)

func _draw_cleat(position: Vector2, foreground: bool) -> void:
	if not foreground:
		draw_rect(Rect2(position-Vector2(44,35),Vector2(88,70)),Color(0,0,0,.34))
		draw_rect(Rect2(position-Vector2(48,39),Vector2(88,70)),IRON)
		draw_circle(position,24,BRASS_DARK)
	else:
		var jaw := 12.0 if docked else 23.0
		draw_line(position+Vector2(-34,jaw),position+Vector2(34,-jaw),BRASS_DARK,16,true)
		draw_line(position+Vector2(-36,jaw-4),position+Vector2(36,-jaw-4),BRASS_LIGHT,8,true)
		draw_line(position+Vector2(-34,-jaw),position+Vector2(34,jaw),BRASS_DARK,16,true)
		draw_line(position+Vector2(-36,-jaw-4),position+Vector2(36,jaw-4),BRASS,8,true)
		draw_circle(position,11,BONE if docked else BRASS_DARK)
		draw_string(_font(),position+Vector2(-42,58),"SET",HORIZONTAL_ALIGNMENT_CENTER,84,10,BONE if docked else CHALK)

func _draw_rope() -> void:
	if points.size() < 2:
		return
	_draw_rope_path(PackedVector2Array(points),15.0,grabbed>=0)
	# Braided strand marks turn a thick line into warm flax rope.
	for i in range(0,N-1):
		if i % 3 == 2:
			continue
		var a := points[i]
		var b := points[i+1]
		var middle := a.lerp(b,.38+.16*float(i%2))
		var tangent := (b-a).normalized()
		var normal := (b-a).normalized().orthogonal()
		draw_line(middle-normal*5.5-tangent*2.5,middle+normal*5.5+tangent*2.5,Color(FLAX_DARK,.48),2.0,true)
		draw_line(middle-normal*3.5-tangent*1.2,middle+normal*3.5+tangent*1.2,Color(FLAX_LIGHT,.28),1.0,true)
	if hover >= 0 and grabbed < 0:
		draw_arc(points[hover],22,0,TAU,28,Color(BONE,.85),2,true)
	if grabbed >= 0:
		draw_circle(points[grabbed]+Vector2(4,8),24,Color(0,0,0,.38))
		draw_arc(points[grabbed],23,-2.6,2.6,30,FLAX_LIGHT,4,true)
		draw_circle(points[grabbed],6,BONE)
	# Fixed bitter end and unmistakable coral whipping on the working end.
	draw_circle(points[0],8,BRASS_LIGHT)
	_draw_working_end()
	# Traveling sheen makes route-wide load visible along the entire line.
	if route_load > .25:
		var phase := fmod(motion_time * (5.0 + route_load * 4.0),float(N-2))
		var index := clampi(int(phase)+1,1,N-2)
		draw_line(points[index-1],points[index+1],Color(1.0,.93,.67,route_load*.72),3.0,true)

func _draw_rope_path(path: PackedVector2Array, width: float, lifted: bool) -> void:
	if path.size() < 2:
		return
	var shadow := PackedVector2Array()
	var offset := Vector2(5,10 if lifted else 7)
	for point in path:
		shadow.append(point+offset)
	draw_polyline(shadow,Color(0,0,0,.48),width+9.0,true)
	draw_polyline(path,FLAX_DARK,width+3.0,true)
	draw_polyline(path,FLAX_LIGHT if route_load>.70 else FLAX,width,true)
	# Long irregular strand seams imply a three-ply braid without sacrificing the
	# silhouette or turning crossings into visual noise.
	for strand in range(3):
		var strand_path := PackedVector2Array()
		for i in range(path.size()):
			var before := path[maxi(0,i-1)]
			var after := path[mini(path.size()-1,i+1)]
			var normal := (after-before).normalized().orthogonal()
			var offset_amount := sin(float(i)*1.22+float(strand)*TAU/3.0)*(width*.20)
			strand_path.append(path[i]+normal*offset_amount-Vector2(1.1,1.7))
		draw_polyline(strand_path,Color(1.0,.90,.63,.18 if strand else .34),maxf(1.0,width*.10),true)

func _draw_working_end() -> void:
	if points.size() < 2:
		return
	var end := points[N-1]
	var tangent := (end-points[N-2]).normalized()
	var normal := tangent.orthogonal()
	for i in range(3):
		var center := end-tangent*(4.0+float(i)*4.0)
		draw_line(center-normal*7.0,center+normal*7.0,CORAL,3.0,true)
	draw_circle(end,6,BONE)
	if not docked:
		draw_string(_font(),end+Vector2(-42,32),"WORKING END",HORIZONTAL_ALIGNMENT_CENTER,84,9,BONE)

func _draw_crossing_clarity() -> void:
	# At self-crossings the later (working-end-side) segment is explicitly on
	# top. A small plate-colored underpass gap removes ambiguous tangencies.
	if points.size() < N:
		return
	for i in range(N-1):
		for j in range(i+3,N-1):
			if i == 0 and j == N-2:
				continue
			var crossing := _segment_intersection(points[i],points[i+1],points[j],points[j+1])
			if crossing.x >= 0.0:
				draw_circle(crossing,11,PLATE_DEEP)
				draw_line(points[j],points[j+1],FLAX_DARK,18,true)
				draw_line(points[j],points[j+1],FLAX_LIGHT if route_load>.7 else FLAX,14,true)

func _segment_intersection(a: Vector2, b: Vector2, c: Vector2, d: Vector2) -> Vector2:
	var r := b-a
	var s := d-c
	var denominator := r.cross(s)
	if absf(denominator) < .001:
		return Vector2(-1,-1)
	var t := (c-a).cross(s)/denominator
	var u := (c-a).cross(r)/denominator
	if t > .08 and t < .92 and u > .08 and u < .92:
		return a+r*t
	return Vector2(-1,-1)

func _draw_fixture_foregrounds() -> void:
	var d: Dictionary = levels[level]
	for eye_index in range(d.eyes.size()):
		var position := _eye_position(eye_index)
		var active := _contact_for_eye(eye_index)
		draw_arc(position,43,-2.82,-.30,28,BRASS_LIGHT if active else BRASS,11,true)
		draw_arc(position,43,.34,2.80,28,BRASS_LIGHT if active else BRASS_DARK,11,true)
	if d.cap != Vector2.ZERO:
		draw_arc(d.cap,59,.08,PI-.08,30,BRASS,8,true)
		draw_circle(d.cap,13,INK)
	_draw_cleat(d.cleat,true)

func _contact_for_eye(eye_index: int) -> bool:
	for contact in contacts:
		if int(contact.eye) == eye_index:
			return true
	return false

func _draw_status_ledger() -> void:
	var items: Array = []
	if not levels[level].expected.is_empty():
		items.append(["PASS",route_ok])
	if bool(levels[level].needs_hold):
		items.append(["HOLD",hold_ok])
	if levels[level].cap != Vector2.ZERO:
		items.append(["TURN",wrap_ok])
	items.append(["LOAD",load_ok])
	items.append(["SET",docked])
	var width := float(items.size()) * 118.0 + 26.0
	var x := 94.0
	draw_rect(Rect2(x-16,621,width,38),Color(0,0,0,.32))
	draw_rect(Rect2(x-20,617,width,38),IRON)
	for item in items:
		var active := bool(item[1])
		draw_circle(Vector2(x,636)+Vector2(2,3),9,Color(0,0,0,.4))
		draw_circle(Vector2(x,636),8,BRASS_LIGHT if active else BRASS_DARK)
		if active:
			draw_line(Vector2(x-4,636),Vector2(x-1,640),INK,2,true)
			draw_line(Vector2(x-1,640),Vector2(x+5,632),INK,2,true)
		draw_string(_font(),Vector2(x+16,641),str(item[0]),HORIZONTAL_ALIGNMENT_LEFT,78,11,BONE if active else CHALK)
		x += 118.0
	draw_string(_font(),Vector2(884,646),"ESC  TITLE     M  %s" % ("SOUND OFF" if audio_muted else "SOUND ON"),HORIZONTAL_ALIGNMENT_LEFT,180,10,CHALK)

func _draw_feedback() -> void:
	if reset_sweep > 0.0:
		var x := lerpf(72.0,1080.0,1.0-reset_sweep)
		draw_line(Vector2(x,176),Vector2(x,596),Color(BONE,reset_sweep*.18),10,true)
	if reject_pulse > 0.0:
		draw_arc(reject_position,20+(1.0-reject_pulse)*28,-2.7,2.7,28,Color(CORAL,reject_pulse),5,true)
		var label_position := Vector2(clampf(reject_position.x-145,82,790),clampf(reject_position.y+58,200,570))
		draw_rect(Rect2(label_position-Vector2(8,18),Vector2(306,28)),Color(INK,reject_pulse*.9))
		draw_string(_font(),label_position,reject_kind,HORIZONTAL_ALIGNMENT_CENTER,290,10,Color(CORAL,reject_pulse))
	for fiber in fibers:
		draw_line(fiber.p,fiber.p-fiber.v.normalized()*8,Color(fiber.color,clampf(float(fiber.life),0,1)),2,true)

func _draw_success_latch() -> void:
	var amount := clampf((1.0-success_pulse)*2.0,0.0,1.0)
	var rect := Rect2(316,274-12*(1.0-amount),520,166)
	draw_rect(Rect2(rect.position+Vector2(7,9),rect.size),Color(0,0,0,.48))
	draw_rect(rect,Color("202b2a"))
	draw_rect(rect.grow(-8),BRASS,false,2.0)
	draw_string(_font(),Vector2(rect.position.x+42,rect.position.y+50),"THE LINE HOLDS",HORIZONTAL_ALIGNMENT_CENTER,436,28,BONE)
	draw_string(_font(),Vector2(rect.position.x+42,rect.position.y+80),"Every contact is live. Pull back to undo it.",HORIZONTAL_ALIGNMENT_CENTER,436,13,CHALK)
	_draw_world_button(_next_rect(),"REPLAY WORKSHOP" if level==3 else "NEXT STUDY",true)

func _draw_chevron(position: Vector2, direction: Vector2, color: Color) -> void:
	var tangent := direction.normalized()
	var normal := tangent.orthogonal()
	draw_line(position-tangent*7+normal*5,position, color,2,true)
	draw_line(position,position-tangent*7-normal*5,color,2,true)

func _draw_world_button(rect: Rect2, text: String, primary: bool) -> void:
	var hovered := rect.has_point(mouse_position)
	draw_rect(Rect2(rect.position+Vector2(5,7),rect.size),Color(0,0,0,.42))
	draw_rect(rect,BRASS_DARK if primary else IRON)
	draw_rect(rect.grow(-4),Color("2b3737") if not primary else Color("6f4922"))
	draw_line(rect.position+Vector2(5,5),Vector2(rect.end.x-5,rect.position.y+5),BRASS_LIGHT if hovered else BRASS,2,true)
	draw_line(Vector2(rect.position.x+5,rect.end.y-5),rect.end-Vector2(5,5),BRASS_DARK,2,true)
	for x in [rect.position.x+12,rect.end.x-12]:
		draw_circle(Vector2(x,rect.get_center().y),3.5,BRASS_LIGHT if primary else BRASS_DARK)
	draw_string(_font(),Vector2(rect.position.x,rect.position.y+rect.size.y*.63),text,HORIZONTAL_ALIGNMENT_CENTER,rect.size.x,14,BONE)

func _begin_rect() -> Rect2:
	return Rect2(846,474,218,76)

func _title_rope_start_rect() -> Rect2:
	# The visible lower rope tail is also a start affordance. Its bounds retain
	# the engine-native capture contract used by the factory's immutable runner.
	return Rect2(540,548,100,60)

func _reset_rect() -> Rect2:
	return Rect2(934,72,130,48)

func _next_rect() -> Rect2:
	return Rect2(900,67,164,54)

# ---------------------------------------------------------------------------
# Deterministic production-path scenario and adversarial boundary fixtures

func factory_setup(parameters: Dictionary) -> void:
	factory_mode = true
	started = true
	level = 0
	factory_ticks = 0
	factory_drag_samples = 0
	solved_levels.clear()
	visited_levels.clear()
	near_misses.clear()
	verbs.clear()
	transitions = 0
	goals = 0
	resets = 0
	progressions = 0
	replays = 0
	invalid_cases = 0
	max_load = 0.0
	_reset(false)
	visited_levels[level] = true

func factory_tick(tick: int) -> void:
	factory_ticks = tick + 1
	var phase := tick % 120
	if phase == 3:
		_factory_adversarial()
	if phase == 9 and levels[level].cap != Vector2.ZERO:
		_factory_discontinuous_wrap()
		_evaluate(1.0/60.0)
		if not wrap_ok:
			invalid_cases += 1
			near_misses.discontinuous_wrap = true
	if phase == 13:
		_reset(false)
		_factory_begin_player_drag()
	if phase >= 14 and phase < 59:
		_factory_step_player_drag(phase-14)
	if phase == 59:
		_factory_release(levels[level].cleat)
	if phase >= 60 and phase < 96:
		_evaluate(1.0/60.0)
	if phase == 97 and solved:
		_advance()
	if phase == 110:
		_reset()

func _factory_adversarial() -> void:
	_reset(false)
	var d: Dictionary = levels[level]
	if level == 0:
		# A taut-looking tail cannot energize a route with upstream slack.
		points.clear()
		for i in range(25):
			points.append(Vector2(d.start)+Vector2(float(i)*4.0,sin(float(i)*.9)*9.0))
		var tail_start := points[-1]
		for i in range(1,10):
			points.append(tail_start.lerp(Vector2(d.cleat),float(i)/9.0))
		docked = true
		_evaluate(1.0/60.0)
		if not load_ok and not solved:
			invalid_cases += 1
			near_misses.tail_only_load = true
		docked = false
		_evaluate(1.0/60.0)
		if not solved:
			invalid_cases += 1
			near_misses.undocked_goal = true
		# A near-end sample may be easy to grab, but only the marked endpoint SETs.
		grabbed = N - 3
		_release(d.cleat)
		if not docked:
			invalid_cases += 1
			near_misses.near_end_set = true
	elif level == 1:
		# Crossing an eye with a midpoint is geometry, not PASS topology.
		var eye := _eye_position(0)
		grabbed = N/2
		points[grabbed] = eye-Vector2(48,0)
		_drag_to(eye+Vector2(48,0))
		grabbed = -1
		_evaluate(1.0/60.0)
		if contacts.is_empty() and not route_ok:
			invalid_cases += 1
			near_misses.midpoint_eye = true
		# The two samples beside the endpoint cannot impersonate its PASS token.
		grabbed = N - 3
		points[grabbed] = eye-Vector2(42,0)
		_drag_to(eye+Vector2(42,0))
		grabbed = -1
		if contacts.is_empty():
			invalid_cases += 1
			near_misses.near_end_pass = true
		# A graze enters and leaves the same side and must not record.
		grabbed = N-1
		points[N-1] = eye-Vector2(42,20)
		_drag_to(eye-Vector2(5,20))
		_drag_to(eye-Vector2(42,-20))
		grabbed = -1
		if contacts.is_empty():
			invalid_cases += 1
			near_misses.eye_graze = true
		# Production PASS is reversible through the same endpoint drag path used
		# by mouse input: left-to-right records, right-to-left pops.
		grabbed = N-1
		points[N-1] = eye-Vector2(42,0)
		_drag_to(eye)
		_drag_to(eye+Vector2(42,0))
		var production_passed := contacts.size() == 1
		_drag_to(eye)
		_drag_to(eye-Vector2(42,0))
		grabbed = -1
		_evaluate(1.0/60.0)
		if production_passed and contacts.is_empty() and not route_ok:
			invalid_cases += 1
			near_misses.reversed_pass = true
	elif level == 2:
		# Free-space pins are rejected; counter-clockwise geometry is not TURN.
		_toggle_socket(Vector2(220,220))
		if socket_index < 0:
			invalid_cases += 1
			near_misses.free_space_pin = true
		var anchors2: Array[Vector2] = [d.start]
		for step in range(19):
			anchors2.append(d.cap+Vector2.from_angle(-2.4-float(step)*TAU/18.0)*82.0)
		anchors2.append(d.end)
		points = _resample(anchors2,N)
		_evaluate(1.0/60.0)
		if not wrap_ok and winding < 0.0:
			invalid_cases += 1
			near_misses.wrong_way_turn = true
		# A valid clockwise turn on material before HOLD is still the wrong word.
		# The current polyline visibly contains that turn, while the only material
		# after the held sample runs directly to the cleat.
		points.clear()
		points.append(d.start)
		for step in range(14):
			points.append(d.cap+Vector2.from_angle(-2.4+float(step)*TAU*1.05/13.0)*82.0)
		var early_wrap_exit := points[-1]
		for step in range(1,7):
			points.append(early_wrap_exit.lerp(Vector2(d.socket),float(step)/6.0))
		socket_index = 20
		for step in range(1,14):
			points.append(Vector2(d.socket).lerp(Vector2(d.cleat),float(step)/13.0))
		_apply_contact_locks()
		_evaluate(1.0/60.0)
		if points.size() == N and not wrap_ok and _turn_material_start() == socket_index:
			invalid_cases += 1
			near_misses.wrong_material_turn = true
	else:
		# A valid prefix plus an extra contact fails exact route matching.
		contacts = [
			{"eye":0,"sense":1,"point":9},
			{"eye":1,"sense":1,"point":16},
			{"eye":0,"sense":1,"point":22}
		]
		_apply_contact_locks()
		_evaluate(1.0/60.0)
		if not route_ok:
			invalid_cases += 1
			near_misses.extra_contact = true

func _factory_discontinuous_wrap() -> void:
	var d: Dictionary = levels[level]
	var anchors: Array[Vector2] = [d.start]
	for step in range(9):
		anchors.append(d.cap+Vector2.from_angle(-2.4+float(step)*PI/8.0)*82.0)
	anchors.append(d.cap+Vector2(165,-22))
	anchors.append(d.cap+Vector2(165,22))
	for step in range(9):
		anchors.append(d.cap+Vector2.from_angle(-2.4+float(step)*PI/8.0)*82.0)
	anchors.append(d.end)
	points = _resample(anchors,N)
	docked = false
	grabbed = N-1

func _factory_begin_player_drag() -> void:
	var d: Dictionary = levels[level]
	if bool(d.needs_hold):
		var index := clampi(int(round(Vector2(d.start).distance_to(Vector2(d.socket))/_segment_length())),1,N-2)
		grabbed = index
		_drag_to(d.socket)
		grabbed = -1
		_toggle_socket(d.socket)
	var anchors: Array[Vector2] = [points[N-1]]
	for eye_index in range(d.eyes.size()):
		var eye := _eye_position(eye_index)
		anchors.append(eye-Vector2(52,0))
		anchors.append(eye)
		anchors.append(eye+Vector2(54,0))
	if d.cap != Vector2.ZERO:
		var approach := anchors[-1]
		var start_angle: float = (approach-Vector2(d.cap)).angle()
		anchors.append(d.cap+Vector2.from_angle(start_angle)*82.0)
		for step in range(1,29):
			anchors.append(d.cap+Vector2.from_angle(start_angle+float(step)*TAU*1.22/28.0)*82.0)
	anchors.append(d.cleat)
	factory_path = _resample(anchors,45)
	grabbed = N-1

func _factory_step_player_drag(step: int) -> void:
	if factory_path.is_empty():
		return
	_drag_to(factory_path[mini(step,factory_path.size()-1)])
	factory_drag_samples += 1
	_evaluate(1.0/60.0)

func _factory_release(position: Vector2) -> void:
	grabbed = N-1
	points[N-1] = position
	_release(position)

func _resample(anchors: Array[Vector2], count: int) -> Array[Vector2]:
	var output: Array[Vector2] = []
	var lengths: Array[float] = []
	var total := 0.0
	for i in range(anchors.size()-1):
		var length := anchors[i].distance_to(anchors[i+1])
		lengths.append(length)
		total += length
	for sample in range(count):
		var target := total*float(sample)/float(count-1)
		var accumulated := 0.0
		for i in range(lengths.size()):
			if target <= accumulated+lengths[i] or i == lengths.size()-1:
				output.append(anchors[i].lerp(anchors[i+1],clampf((target-accumulated)/maxf(lengths[i],.001),0.0,1.0)))
				break
			accumulated += lengths[i]
	return output

func factory_sample() -> Dictionary:
	return {
		"level":level+1,
		"rope_points":points.size(),
		"finite_state":finite_state,
		"contact_word":route_signature.duplicate(true),
		"route_valid":route_ok,
		"hold_valid":hold_ok,
		"socket_point":socket_index,
		"signed_winding":snappedf(winding,.001),
		"wrap_valid":wrap_ok,
		"turn_material_start":_turn_material_start(),
		"span_loads":span_loads.duplicate(),
		"weakest_span_load":snappedf(route_load,.001),
		"docked":docked,
		"load_height":snappedf(load_height,.001),
		"invalid_contacts":invalid_cases,
		"near_misses":near_misses.keys(),
		"predicate_transitions":transitions,
		"goal_transitions":goals,
		"success_latched":solved,
		"verbs":verbs.keys(),
		"player_drag_samples":factory_drag_samples
	}

func factory_collect() -> Dictionary:
	var solved_fraction := float(solved_levels.size())/float(levels.size())
	var verb_fraction := clampf(float(verbs.size())/8.0,0.0,1.0)
	var transition_fraction := clampf(float(transitions)/18.0,0.0,1.0)
	var navigation_fraction := clampf(float(progressions+resets+replays)/8.0,0.0,1.0)
	var score := solved_fraction*.40+verb_fraction*.16+transition_fraction*.14+navigation_fraction*.10+clampf(max_load,0.0,1.0)*.20
	var violations: Array = []
	if not finite_state:
		violations.append({"code":"knot-theory.non-finite","message":"Non-finite rope coordinate.","severity":"error"})
	if solved_levels.size() < levels.size():
		violations.append({"code":"knot-theory.goal-coverage","message":"Not all four live geometric goals were observed.","severity":"error"})
	if visited_levels.size() < levels.size() or progressions < 3 or replays < 1:
		violations.append({"code":"knot-theory.navigation","message":"Progression and replay paths were not fully observed.","severity":"error"})
	if near_misses.size() < 7:
		violations.append({"code":"knot-theory.near-misses","message":"Reversal, route, hold, wrap, and load boundaries lacked coverage.","severity":"error"})
	if verbs.size() < 5:
		violations.append({"code":"knot-theory.verbs","message":"Fewer than five direct rope verbs were observed.","severity":"error"})
	if factory_drag_samples < 180:
		violations.append({"code":"knot-theory.player-input-coverage","message":"Successful scenarios did not exercise 180 incremental production drags.","severity":"error"})
	if max_load < .68:
		violations.append({"code":"knot-theory.finale-load","message":"The live routed finale did not move the hoist far enough.","severity":"error"})
	return {
		"metrics":{
			"scenario_score":snappedf(score,.001),
			"rope_points":points.size(),
			"levels_playable":visited_levels.size(),
			"goals_detected":goals,
			"interaction_modes":verbs.size(),
			"predicate_transitions":transitions,
			"solved_levels":solved_levels.size(),
			"finale_load_displacement":snappedf(max_load,.001),
			"invalid_cases_observed":invalid_cases,
			"near_miss_types":near_misses.size(),
			"reset_coverage":resets,
			"progression_coverage":progressions,
			"replay_coverage":replays,
			"player_drag_samples":factory_drag_samples
		},
		"violations":violations
	}
