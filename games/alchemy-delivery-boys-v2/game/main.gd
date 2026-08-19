extends Node2D

const VIEW_SIZE := Vector2(480.0, 270.0)
const MOVE_SPEED := 118.0
const INTERACT_RANGE := 28.0

const PARTNER_POS := Vector2(106.0, 155.0)
const EMBER_POS := Vector2(71.0, 201.0)
const MOSS_POS := Vector2(83.0, 223.0)
const CAULDRON_POS := Vector2(69.0, 139.0)
const RECIPIENT_POS := Vector2(405.0, 160.0)
const FOLLOWUP_SUN_POS := Vector2(348.0, 212.0)
const FOLLOWUP_HERB_POS := Vector2(385.0, 215.0)

const INK := Color("1b1a24")
const DEEP_SLATE := Color("2a3341")
const PLUM_SHADOW := Color("44354e")
const WOOD := Color("6b4638")
const EMBER := Color("e66a3c")
const WARMTH := Color("f3b94e")
const PAPER := Color("f4e1b5")
const MOSS_DARK := Color("345b43")
const MOSS := Color("69a35c")
const SOOTHING := Color("83c9a0")
const WIND := Color("b7dce1")
const SPECULAR := Color("fff3ce")
const ROSE := Color("c97878")

const ENVIRONMENT: Texture2D = preload("res://game/assets/production/first-delivery/environment/village-environment.png")
const CAULDRON_SHEET: Texture2D = preload("res://game/assets/production/first-delivery/interactables/cauldron.png")
const EMBER_SHEET: Texture2D = preload("res://game/assets/production/first-delivery/interactables/ember-ingredient.png")
const MOSS_SHEET: Texture2D = preload("res://game/assets/production/first-delivery/interactables/moss-ingredient.png")
const COURIER_SHEET: Texture2D = preload("res://game/assets/production/first-delivery/characters/courier.png")
const PARTNER_SHEET: Texture2D = preload("res://game/assets/production/first-delivery/characters/partner.png")
const MIRA_SHEET: Texture2D = preload("res://game/assets/production/first-delivery/characters/mira.png")
const BOTTLE_SHEET: Texture2D = preload("res://game/assets/production/first-delivery/props/bottle.png")
const GUST_SIGN: Texture2D = preload("res://game/assets/production/first-delivery/interface/gust-sign.png")
const SHELTER_SIGN: Texture2D = preload("res://game/assets/production/first-delivery/interface/shelter-sign.png")
const ROUTE_EFFECTS: Texture2D = preload("res://game/assets/production/first-delivery/effects/route-effects.png")
const REACTION_EFFECTS: Texture2D = preload("res://game/assets/production/first-delivery/effects/reaction-effects.png")
const SUNMILL_PENNANT: Texture2D = preload("res://game/assets/production/first-delivery/interface/sunmill-pennant.png")
const HERBALIST_PENNANT: Texture2D = preload("res://game/assets/production/first-delivery/interface/herbalist-pennant.png")
const BODY_FONT: Font = preload("res://game/assets/production/first-delivery/interface/fonts/DejaVuSans.ttf")
const BOLD_FONT: Font = preload("res://game/assets/production/first-delivery/interface/fonts/DejaVuSans-Bold.ttf")
const FOLLOWUP_REQUESTS := {
	"sunmill_cough": {
		"requester": "Sunmill baker", "need": {"warm": 3, "soothing": 0},
		"journey_effect": "Exposed gust can add warmth when the bottle contains soothing.",
		"route_plan": "exposed", "consequence": "Trade soothing for the extra warmth the cough needs."
	},
	"herbalist_chill": {
		"requester": "Herbalist", "need": {"warm": 1, "soothing": 2},
		"journey_effect": "Shelter preserves a soothing-heavy bottle.",
		"route_plan": "sheltered", "consequence": "Protect soothing from the gust for the herbalist's chill."
	}
}

var elapsed := 0.0
var player_position := Vector2(130.0, 165.0)
var need_active := false
var need := {"warm": 2, "soothing": 1}
var contributions: Array[String] = []
var bottled := false
var bottled_state := {"warm": 0, "soothing": 0}
var carrying := false
var chosen_route := ""
var route_delta := {"warm": 0, "soothing": 0}
var delivered_state := {"warm": 0, "soothing": 0}
var reaction := ""
var reaction_cause := ""
var learned_relationship := ""
var followup_options: Array[String] = []
var followup_choice := ""
var selected_followup: Dictionary = {}
var feedback_line := "Walk with WASD / arrows. SPACE or E acts."
var move_direction := Vector2.DOWN
var courier_is_moving := false
var active_motion_beat := "opening"
var motion_beat_started_at := 0.0
var last_ingredient := ""
var motion_frame_paths: Array[String] = []
var last_motion_capture_tick := -1
var pending_captures: Array[Dictionary] = []

var scenario_mode := "manual"
var scenario_seed := 0
var factory_mode := false
var factory_tick_index := -1
var factory_hz := 60
var factory_actions: Array[Dictionary] = []
var factory_action_index := 0
var trace: Array[Dictionary] = []
var events_this_tick: Array[Dictionary] = []
var current_input := {"kind": "none", "x": 0.0, "y": 0.0, "action": ""}
var setup_violation := ""
var route_sample_bucket := -1
var post_reaction_move_recorded := false
var evidence_dir := ""
var captured_paths: Array[String] = []


func _ready() -> void:
	queue_redraw()


func _process(delta: float) -> void:
	elapsed += delta
	queue_redraw()


func _physics_process(delta: float) -> void:
	if factory_mode:
		return
	var direction := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	if direction.length_squared() > 0.0:
		move_courier(direction, delta, "player_axis")
	else:
		courier_is_moving = false
		current_input = {"kind": "none", "x": 0.0, "y": 0.0, "action": ""}
	if Input.is_key_pressed(KEY_SPACE) or Input.is_key_pressed(KEY_E):
		if not get_meta("action_latched", false):
			set_meta("action_latched", true)
			perform_context_action("player_context_action")
	else:
		set_meta("action_latched", false)


func move_courier(direction: Vector2, delta: float, input_kind: String) -> void:
	var normalized := direction.normalized()
	move_direction = normalized
	courier_is_moving = true
	current_input = {
		"kind": input_kind,
		"x": snappedf(normalized.x, 0.001),
		"y": snappedf(normalized.y, 0.001),
		"action": "move"
	}
	player_position += normalized * MOVE_SPEED * delta
	player_position.x = clampf(player_position.x, 18.0, VIEW_SIZE.x - 18.0)
	player_position.y = clampf(player_position.y, 48.0, VIEW_SIZE.y - 18.0)
	if carrying and chosen_route.is_empty():
		var sample_bucket := int(player_position.x / 32.0)
		if sample_bucket != route_sample_bucket:
			route_sample_bucket = sample_bucket
			record_event("route_navigation_sample", {
				"available_routes": ["exposed", "sheltered"],
				"carried_state": bottled_state.duplicate(), "position_causes_route": true
			})
	elif not reaction.is_empty() and followup_choice.is_empty() and not post_reaction_move_recorded:
		post_reaction_move_recorded = true
		record_event("followup_navigation_sample", {
			"available_requests": followup_options.duplicate(),
			"retained_knowledge": learned_relationship
		})
	apply_route_crossing()


func perform_context_action(input_kind: String) -> bool:
	current_input = {"kind": input_kind, "x": 0.0, "y": 0.0, "action": "interact"}
	if not need_active and player_position.distance_to(PARTNER_POS) <= INTERACT_RANGE:
		need_active = true
		feedback_line = "Mira needs WARM 2 + SOOTHING 1. Choose a brew."
		start_motion_beat("partner-disclosure")
		record_event("need_disclosed", {
			"target": "partner", "need": need.duplicate(),
			"alternatives": ["ember adds warm", "moss adds soothing"]
		})
		return true
	if need_active and not bottled:
		var ember_distance := player_position.distance_to(EMBER_POS)
		var moss_distance := player_position.distance_to(MOSS_POS)
		if minf(ember_distance, moss_distance) <= INTERACT_RANGE:
			add_ingredient("ember" if ember_distance <= moss_distance else "moss")
			return true
	if need_active and not bottled and player_position.distance_to(CAULDRON_POS) <= INTERACT_RANGE:
		if contributions.size() < 2:
			feedback_line = "The bottle needs at least two ingredient doses."
			record_event("invalid_bottle", {"cause": "fewer_than_two_contributions"})
			return false
		bottle_potion()
		return true
	if carrying and player_position.distance_to(RECIPIENT_POS) <= INTERACT_RANGE:
		if chosen_route.is_empty():
			feedback_line = "The potion must pass through a route before delivery."
			record_event("invalid_delivery", {"cause": "no_route_crossed"})
			return false
		deliver_potion()
		return true
	if not reaction.is_empty() and player_position.distance_to(FOLLOWUP_SUN_POS) <= 24.0:
		choose_followup("sunmill_cough")
		return true
	if not reaction.is_empty() and player_position.distance_to(FOLLOWUP_HERB_POS) <= 24.0:
		choose_followup("herbalist_chill")
		return true
	feedback_line = "Nothing to act on here. Move beside a labeled marker."
	record_event("invalid_context_action", {"target": "none"})
	return false


func add_ingredient(ingredient: String) -> void:
	contributions.append(ingredient)
	last_ingredient = ingredient
	var preview := calculate_brew(contributions)
	feedback_line = "%s added: brew now W%d / S%d." % [ingredient.capitalize(), preview.warm, preview.soothing]
	start_motion_beat("ingredient-add")
	record_event("ingredient_added", {
		"ingredient": ingredient, "sequence": contributions.duplicate(), "preview": preview,
		"alternative": "ember" if ingredient == "moss" else "moss"
	})


func calculate_brew(sequence: Array[String]) -> Dictionary:
	var result := {"warm": 0, "soothing": 0}
	for ingredient in sequence:
		if ingredient == "ember":
			result.warm += 1
		elif ingredient == "moss":
			result.soothing += 1
	return result


func bottle_potion() -> void:
	bottled_state = calculate_brew(contributions)
	bottled = true
	carrying = true
	feedback_line = "Bottled W%d / S%d. Exposed lane converts 1 S to W; shelter preserves." % [bottled_state.warm, bottled_state.soothing]
	start_motion_beat("brew-commit")
	record_event("brew_committed", {
		"contributions": contributions.duplicate(), "bottled_state": bottled_state.duplicate(),
		"route_alternatives": {
			"exposed": "convert one soothing to warm",
			"sheltered": "preserve bottled state"
		}
	})


func apply_route_crossing() -> void:
	if not carrying or not chosen_route.is_empty() or player_position.x < 276.0:
		return
	if player_position.y < 136.0:
		chosen_route = "exposed"
		route_delta = {"warm": 0, "soothing": 0}
		if bottled_state.soothing > 0:
			route_delta = {"warm": 1, "soothing": -1}
			feedback_line = "EXPOSED gust changed the bottle: +1 W / -1 S."
		start_motion_beat("exposed-conversion")
	else:
		chosen_route = "sheltered"
		route_delta = {"warm": 0, "soothing": 0}
		feedback_line = "SHELTER preserved the bottled qualities."
		start_motion_beat("sheltered-preservation")
	record_event("route_selected", {
		"route": chosen_route, "alternative": "sheltered" if chosen_route == "exposed" else "exposed",
		"pre_route": bottled_state.duplicate(), "delta": route_delta.duplicate(),
		"post_route": state_after_route()
	})


func state_after_route() -> Dictionary:
	return {
		"warm": bottled_state.warm + route_delta.warm,
		"soothing": bottled_state.soothing + route_delta.soothing
	}


func deliver_potion() -> void:
	delivered_state = state_after_route()
	carrying = false
	var matched := delivered_state == need
	reaction = "satisfied" if matched else "imperfect"
	start_motion_beat("satisfied-handoff" if matched else "imperfect-handoff")
	if matched:
		reaction_cause = "Mira is relieved: delivered W2 / S1 exactly matches her need."
		learned_relationship = "The exposed gust can correct a soothing-heavy brew."
	else:
		reaction_cause = "Mira still shivers: delivered W%d / S%d, but she needed W2 / S1." % [delivered_state.warm, delivered_state.soothing]
		learned_relationship = "Shelter preserves a mismatch; alter the brew or take the exposed lane."
	followup_options = ["sunmill_cough", "herbalist_chill"]
	feedback_line = reaction_cause
	record_event("delivery_resolved", {
		"need": need.duplicate(), "bottled_state": bottled_state.duplicate(),
		"route": chosen_route, "route_delta": route_delta.duplicate(),
		"delivered_state": delivered_state.duplicate(), "reaction": reaction,
		"reaction_cause": reaction_cause, "retained_knowledge": learned_relationship,
		"followup_alternatives": followup_options.duplicate()
	})
	record_event("followup_requests_disclosed", {
		"requests": followup_request_snapshot(),
		"retained_knowledge": learned_relationship,
		"prior_reaction": reaction
	})


func choose_followup(choice: String) -> void:
	if not followup_options.has(choice) or not followup_choice.is_empty():
		return
	followup_choice = choice
	selected_followup = FOLLOWUP_REQUESTS[choice].duplicate(true)
	start_motion_beat("followup-selected")
	var other_choice := followup_options[0] if followup_options[1] == choice else followup_options[1]
	feedback_line = "Next: %s via %s. Lesson applied." % [selected_followup.requester, selected_followup.route_plan]
	record_event("followup_selected", {
		"choice": followup_choice, "alternatives": followup_options.duplicate(),
		"selected_request": selected_followup.duplicate(true),
		"contrasted_request": FOLLOWUP_REQUESTS[other_choice].duplicate(true),
		"informed_by": learned_relationship, "prior_reaction": reaction,
		"resulting_plan": selected_followup.route_plan,
		"resulting_consequence": selected_followup.consequence
	})


func followup_request_snapshot() -> Dictionary:
	var result := {}
	for request_id in followup_options:
		result[request_id] = FOLLOWUP_REQUESTS[request_id].duplicate(true)
	return result


func record_event(event_name: String, data: Dictionary = {}) -> void:
	var item := {
		"index": trace.size(),
		"tick": factory_tick_index,
		"time": snappedf(float(factory_tick_index) / float(factory_hz), 0.001) if factory_mode else snappedf(elapsed, 0.001),
		"scenario": scenario_mode,
		"seed": scenario_seed,
		"input": current_input.duplicate(true),
		"position": {"x": snappedf(player_position.x, 0.01), "y": snappedf(player_position.y, 0.01)},
		"event": event_name,
		"need_active": need_active
	}
	item.merge(data, true)
	trace.append(item)
	events_this_tick.append(item.duplicate(true))
	var capture_delays := {
		"need_disclosed": 12,
		"brew_committed": 30,
		"route_selected": 18,
		"delivery_resolved": 30,
		"followup_selected": 12
	}
	if factory_mode and capture_delays.has(event_name):
		pending_captures.append({"event": event_name, "due_tick": factory_tick_index + int(capture_delays[event_name])})


func motion_clock() -> float:
	return float(factory_tick_index) / float(factory_hz) if factory_mode and factory_tick_index >= 0 else elapsed


func start_motion_beat(beat: String) -> void:
	active_motion_beat = beat
	motion_beat_started_at = motion_clock()


func motion_beat_age() -> float:
	return maxf(0.0, motion_clock() - motion_beat_started_at)


func scene_state() -> String:
	if not followup_choice.is_empty():
		return "followup-selection"
	if not reaction.is_empty():
		if active_motion_beat.ends_with("handoff") and motion_beat_age() < 1.15:
			return "satisfied-delivery" if reaction == "satisfied" else "imperfect-recovery"
		return "followup-selection"
	if carrying and chosen_route == "exposed":
		return "exposed-conversion"
	if carrying and chosen_route == "sheltered":
		return "sheltered-preservation"
	if bottled:
		return "route-pending"
	if not contributions.is_empty():
		return "mix-feedback"
	if need_active:
		return "need-disclosed"
	return "pre-disclosure"


func _draw() -> void:
	# Runtime composition follows the approved target's layer ownership.
	draw_texture(ENVIRONMENT, Vector2.ZERO)
	draw_texture(GUST_SIGN, Vector2(188.0, 76.0))
	draw_texture(SHELTER_SIGN, Vector2(208.0, 191.0))
	draw_ambient_continuity()

	var simmer_frame := int(motion_clock() * 4.4) % 4
	draw_sheet_frame(CAULDRON_SHEET, Vector2(53.0, 108.0), Vector2(32.0, 32.0), simmer_frame, 4)
	draw_sheet_frame(EMBER_SHEET, EMBER_POS - Vector2(8.0, 15.0), Vector2(16.0, 16.0), int(motion_clock() * 3.8) % 4, 4)
	draw_sheet_frame(MOSS_SHEET, MOSS_POS - Vector2(8.0, 15.0), Vector2(16.0, 16.0), int(motion_clock() * 3.1 + 1.0) % 4, 4)

	var partner_frame := 2 if active_motion_beat == "partner-disclosure" and motion_beat_age() < 0.55 else int(motion_clock() * 1.3) % 2
	var partner_breathe := -1.0 if int(motion_clock() * 1.3) % 2 else 0.0
	draw_sheet_frame(PARTNER_SHEET, PARTNER_POS - Vector2(12.0, 31.0) + Vector2(0.0, partner_breathe), Vector2(24.0, 32.0), partner_frame, 4)

	draw_route_motion()
	draw_reaction_motion()
	draw_mira()
	draw_courier_and_bottle()
	draw_followup_pennants()
	draw_ingredient_pop()
	draw_world_interface()
	draw_screen_interface()


func draw_sheet_frame(texture: Texture2D, destination: Vector2, frame_size: Vector2, frame: int, columns: int, modulate := Color.WHITE) -> void:
	var source := Rect2(Vector2(float(frame % columns) * frame_size.x, float(frame / columns) * frame_size.y), frame_size)
	draw_texture_rect_region(texture, Rect2(destination.round(), frame_size), source, modulate)


func draw_ambient_continuity() -> void:
	var wind_frame := int(motion_clock() * 3.0) % 3
	var quiet := Color(1.0, 1.0, 1.0, 0.42)
	draw_sheet_frame(ROUTE_EFFECTS, Vector2(222.0, 64.0), Vector2(32.0, 32.0), wind_frame, 5, quiet)
	draw_sheet_frame(ROUTE_EFFECTS, Vector2(255.0, 77.0), Vector2(32.0, 32.0), (wind_frame + 1) % 3, 5, Color(1.0, 1.0, 1.0, 0.28))


func draw_route_motion() -> void:
	var age := motion_beat_age()
	if active_motion_beat == "exposed-conversion" and age < 1.0:
		var effect_frame := mini(4, int(age * 7.0))
		for offset in [Vector2(-23.0, -15.0), Vector2(4.0, -5.0), Vector2(28.0, 4.0)]:
			draw_sheet_frame(ROUTE_EFFECTS, player_position + offset - Vector2(16.0, 16.0), Vector2(32.0, 32.0), effect_frame, 5)
	elif active_motion_beat == "sheltered-preservation" and age < 1.0:
		var effect_frame := 3 + (int(age * 6.0) % 2)
		draw_sheet_frame(ROUTE_EFFECTS, player_position - Vector2(16.0, 21.0), Vector2(32.0, 32.0), effect_frame, 5)


func draw_reaction_motion() -> void:
	if not active_motion_beat.ends_with("handoff") or motion_beat_age() > 1.1:
		return
	var frame := mini(4, int(motion_beat_age() * 6.0))
	var tint := Color.WHITE if reaction == "satisfied" else Color(0.82, 0.72, 1.0, 0.9)
	draw_sheet_frame(REACTION_EFFECTS, RECIPIENT_POS - Vector2(16.0, 38.0), Vector2(32.0, 32.0), frame, 5, tint)


func draw_mira() -> void:
	var frame := int(motion_clock() * 1.1) % 2
	if active_motion_beat.ends_with("handoff"):
		var age := motion_beat_age()
		if age < 0.24:
			frame = 1
		elif reaction == "satisfied":
			frame = 2
		else:
			frame = 3 if int(age * 12.0) % 2 else 4
	var breathe := -1.0 if frame == 1 and reaction.is_empty() else 0.0
	draw_sheet_frame(MIRA_SHEET, RECIPIENT_POS - Vector2(12.0, 31.0) + Vector2(0.0, breathe), Vector2(24.0, 32.0), frame, 5)


func courier_frame_index() -> int:
	if active_motion_beat == "ingredient-add" and motion_beat_age() < 0.32:
		return 9
	if active_motion_beat == "brew-commit" and motion_beat_age() < 0.45:
		return 9
	if active_motion_beat == "exposed-conversion" and motion_beat_age() < 0.72:
		return 10
	if active_motion_beat.ends_with("handoff") and motion_beat_age() < 0.52:
		return 11
	var phase := int(motion_clock() * 8.0) % 2
	if absf(move_direction.x) > absf(move_direction.y):
		return 7 + phase if courier_is_moving else 6
	if move_direction.y < 0.0:
		return 4 + phase if courier_is_moving else 3
	return 1 + phase if courier_is_moving else 0


func draw_courier_and_bottle() -> void:
	var courier_position := player_position - Vector2(12.0, 31.0)
	draw_sheet_frame(COURIER_SHEET, courier_position, Vector2(24.0, 32.0), courier_frame_index(), 6)
	var bottle_frame := 1 if state_after_route().warm >= 2 else 0
	if active_motion_beat == "brew-commit" and motion_beat_age() < 0.45:
		var rise := clampf(motion_beat_age() / 0.45, 0.0, 1.0)
		var bottle_position := CAULDRON_POS.lerp(player_position + Vector2(13.0, -13.0), rise)
		draw_sheet_frame(BOTTLE_SHEET, bottle_position - Vector2(6.0, 15.0), Vector2(12.0, 16.0), bottle_frame, 4)
	elif active_motion_beat.ends_with("handoff") and motion_beat_age() < 0.42:
		var handoff := clampf(motion_beat_age() / 0.42, 0.0, 1.0)
		var bottle_position := (player_position + Vector2(13.0, -13.0)).lerp(RECIPIENT_POS + Vector2(-12.0, -13.0), handoff)
		draw_sheet_frame(BOTTLE_SHEET, bottle_position - Vector2(6.0, 15.0), Vector2(12.0, 16.0), 2, 4)
	elif carrying:
		draw_sheet_frame(BOTTLE_SHEET, player_position + Vector2(6.0, -24.0), Vector2(12.0, 16.0), bottle_frame, 4)


func draw_ingredient_pop() -> void:
	if active_motion_beat != "ingredient-add" or motion_beat_age() > 0.45:
		return
	var source := EMBER_POS if last_ingredient == "ember" else MOSS_POS
	var progress := ease(clampf(motion_beat_age() / 0.45, 0.0, 1.0), -1.6)
	var arc := Vector2(0.0, -18.0 * sin(progress * PI))
	var position := source.lerp(CAULDRON_POS - Vector2(0.0, 8.0), progress) + arc
	var texture := EMBER_SHEET if last_ingredient == "ember" else MOSS_SHEET
	draw_sheet_frame(texture, position - Vector2(8.0, 15.0), Vector2(16.0, 16.0), 3, 4)


func draw_followup_pennants() -> void:
	if scene_state() != "followup-selection":
		return
	var sun_frame := int(motion_clock() * 4.0) % 2
	var herb_frame := int(motion_clock() * 3.5 + 1.0) % 2
	if followup_choice == "sunmill_cough":
		sun_frame = 2
		herb_frame = 3
	elif followup_choice == "herbalist_chill":
		herb_frame = 2
		sun_frame = 3
	draw_sheet_frame(SUNMILL_PENNANT, FOLLOWUP_SUN_POS - Vector2(8.0, 23.0), Vector2(16.0, 24.0), sun_frame, 4)
	draw_sheet_frame(HERBALIST_PENNANT, FOLLOWUP_HERB_POS - Vector2(8.0, 23.0), Vector2(16.0, 24.0), herb_frame, 4)


func panel_points(rect: Rect2, cut := 4.0) -> PackedVector2Array:
	var left := rect.position.x
	var top := rect.position.y
	var right := rect.end.x - 1.0
	var bottom := rect.end.y - 1.0
	return PackedVector2Array([
		Vector2(left + cut, top), Vector2(right - cut, top), Vector2(right, top + cut),
		Vector2(right, bottom - cut), Vector2(right - cut, bottom), Vector2(left + cut, bottom),
		Vector2(left, bottom - cut), Vector2(left, top + cut)
	])


func draw_authored_panel(rect: Rect2, fill := PAPER, border := INK, accent := Color.TRANSPARENT) -> void:
	draw_colored_polygon(panel_points(Rect2(rect.position + Vector2(2.0, 2.0), rect.size)), PLUM_SHADOW)
	draw_colored_polygon(panel_points(rect), border)
	draw_colored_polygon(panel_points(Rect2(rect.position + Vector2.ONE, rect.size - Vector2(2.0, 2.0)), 3.0), fill)
	if accent.a > 0.0:
		draw_line(rect.position + Vector2(5.0, rect.size.y - 3.0), rect.position + Vector2(rect.size.x - 6.0, rect.size.y - 3.0), accent, 1.0)


func draw_sun_icon(center: Vector2) -> void:
	draw_colored_polygon(PackedVector2Array([center + Vector2(0, -4), center + Vector2(4, 0), center + Vector2(0, 4), center + Vector2(-4, 0)]), WARMTH)
	draw_polyline(PackedVector2Array([center + Vector2(0, -4), center + Vector2(4, 0), center + Vector2(0, 4), center + Vector2(-4, 0), center + Vector2(0, -4)]), INK, 1.0)
	for offset in [Vector2(0, -7), Vector2(7, 0), Vector2(0, 7), Vector2(-7, 0)]:
		draw_line(center + offset, center + offset * 0.72, WARMTH, 1.0)


func draw_leaf_icon(center: Vector2) -> void:
	draw_colored_polygon(PackedVector2Array([center + Vector2(-5, 1), center + Vector2(-2, -3), center + Vector2(4, -3), center + Vector2(5, 1), center + Vector2(2, 4), center + Vector2(-4, 4)]), SOOTHING)
	draw_line(center + Vector2(-3, 3), center + Vector2(3, -2), MOSS_DARK, 1.0)


func draw_potion_rows(origin: Vector2, warmth_value: int, soothing_value: int) -> void:
	draw_sun_icon(origin + Vector2(6.0, 5.0))
	draw_string(BODY_FONT, origin + Vector2(17.0, 10.0), "%d Warmth" % warmth_value, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, INK)
	draw_leaf_icon(origin + Vector2(6.0, 22.0))
	draw_string(BODY_FONT, origin + Vector2(17.0, 27.0), "%d Soothing" % soothing_value, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, INK)


func draw_request_status(past_tense := false) -> void:
	var rect := Rect2(6.0, 3.0, 142.0, 65.0)
	draw_authored_panel(rect)
	draw_string(BOLD_FONT, Vector2(12.0, 20.0), "Mira needed" if past_tense else "Mira needs", HORIZONTAL_ALIGNMENT_LEFT, -1, 11, INK)
	draw_potion_rows(Vector2(12.0, 27.0), 2, 1)


func draw_carried_status() -> void:
	if active_motion_beat == "brew-commit" and motion_beat_age() < 0.35:
		return
	var rect := Rect2(340.0, 3.0, 136.0, 66.0)
	draw_authored_panel(rect, Color("d8b77c"))
	draw_string(BOLD_FONT, Vector2(347.0, 20.0), "Bottled" if chosen_route.is_empty() else "Carried", HORIZONTAL_ALIGNMENT_LEFT, -1, 11, INK)
	var state := state_after_route()
	draw_potion_rows(Vector2(347.0, 28.0), state.warm, state.soothing)
	draw_rect(Rect2(451.0, 13.0, 11.0, 23.0), SPECULAR, true)
	draw_rect(Rect2(451.0, 13.0, 11.0, 23.0), INK, false, 1.0)
	draw_rect(Rect2(454.0, 9.0, 5.0, 4.0), WOOD, true)


func draw_feedback_panel(heading: String, detail: String, width := 286.0) -> void:
	var rect := Rect2(6.0, 222.0, width, 43.0)
	draw_authored_panel(rect)
	draw_string(BOLD_FONT, Vector2(12.0, 239.0), heading, HORIZONTAL_ALIGNMENT_LEFT, -1, 11, INK)
	draw_string(BODY_FONT, Vector2(12.0, 257.0), detail, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, INK)


func draw_comparison() -> void:
	if active_motion_beat.ends_with("handoff") and motion_beat_age() < 0.4:
		return
	var rect := Rect2(6.0, 205.0, 228.0, 60.0)
	draw_authored_panel(rect)
	draw_string(BOLD_FONT, Vector2(12.0, 222.0), "Arrived", HORIZONTAL_ALIGNMENT_LEFT, -1, 11, INK)
	draw_sun_icon(Vector2(18.0, 233.0))
	draw_string(BODY_FONT, Vector2(29.0, 238.0), "%d Warmth" % delivered_state.warm, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, INK)
	draw_leaf_icon(Vector2(101.0, 233.0))
	draw_string(BODY_FONT, Vector2(112.0, 238.0), "%d Soothing" % delivered_state.soothing, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, INK)
	var outcome := "Exact match" if reaction == "satisfied" else "Imperfect — recoverable"
	draw_string(BOLD_FONT, Vector2(12.0, 257.0), outcome, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, MOSS_DARK if reaction == "satisfied" else ROSE)


func draw_reaction_label() -> void:
	if active_motion_beat.ends_with("handoff") and motion_beat_age() < 0.24:
		return
	var rect := Rect2(382.0, 73.0, 72.0, 24.0)
	draw_authored_panel(rect, Color("efc968") if reaction == "satisfied" else Color("d9a0ae"))
	var label := "RELIEF" if reaction == "satisfied" else "SHIVER"
	draw_string(BOLD_FONT, Vector2(393.0, 90.0), label, HORIZONTAL_ALIGNMENT_CENTER, 50.0, 12, INK)


func draw_world_label(rect: Rect2, label: String, accent: Color) -> void:
	draw_authored_panel(rect, DEEP_SLATE, SPECULAR, accent)
	draw_string(BODY_FONT, rect.position + Vector2(3.0, 14.0), label, HORIZONTAL_ALIGNMENT_CENTER, rect.size.x - 6.0, 10, SPECULAR)


func draw_info_sign(rect: Rect2, title: String, detail: String, accent: Color, selected: bool, dimmed: bool) -> void:
	var fill := Color(DEEP_SLATE, 0.62) if dimmed else DEEP_SLATE
	draw_authored_panel(rect, fill, accent if selected else INK, accent if selected else Color.TRANSPARENT)
	var text_color := Color(SPECULAR, 0.55) if dimmed else SPECULAR
	draw_string(BOLD_FONT, rect.position + Vector2(4.0, 14.0), title, HORIZONTAL_ALIGNMENT_LEFT, rect.size.x - 8.0, 11, text_color)
	draw_string(BODY_FONT, rect.position + Vector2(4.0, 29.0), detail, HORIZONTAL_ALIGNMENT_LEFT, rect.size.x - 8.0, 11, Color(accent, 0.55) if dimmed else accent)


func current_context_prompt() -> Dictionary:
	if not need_active and player_position.distance_to(PARTNER_POS) <= INTERACT_RANGE:
		return {"rect": Rect2(102.0, 82.0, 50.0, 19.0), "label": "E TALK", "accent": WARMTH}
	if need_active and not bottled:
		var ember_distance := player_position.distance_to(EMBER_POS)
		var moss_distance := player_position.distance_to(MOSS_POS)
		if minf(ember_distance, moss_distance) <= INTERACT_RANGE:
			return {"rect": Rect2(104.0, 170.0, 46.0, 19.0), "label": "E ADD", "accent": EMBER} if ember_distance <= moss_distance else {"rect": Rect2(96.0, 190.0, 46.0, 19.0), "label": "E ADD", "accent": SOOTHING}
	if need_active and not bottled and player_position.distance_to(CAULDRON_POS) <= INTERACT_RANGE:
		return {"rect": Rect2(96.0, 74.0, 46.0, 19.0), "label": "E MIX", "accent": Color("8467a8")}
	if carrying and not chosen_route.is_empty() and player_position.distance_to(RECIPIENT_POS) <= INTERACT_RANGE:
		return {"rect": Rect2(382.0, 73.0, 72.0, 19.0), "label": "E GIVE", "accent": WARMTH}
	if scene_state() == "followup-selection" and not reaction.is_empty() and (player_position.distance_to(FOLLOWUP_SUN_POS) <= 24.0 or player_position.distance_to(FOLLOWUP_HERB_POS) <= 24.0):
		return {"rect": Rect2(270.0, 190.0, 38.0, 19.0), "label": "E GO", "accent": WARMTH}
	return {}


func draw_world_action_cue(prompt: Dictionary) -> void:
	var rect: Rect2 = prompt.rect
	var pressed := motion_beat_age() < 0.11 and active_motion_beat in ["partner-disclosure", "ingredient-add", "brew-commit", "followup-selected"]
	if pressed:
		rect.position += Vector2(0.0, 1.0)
	draw_authored_panel(rect, SPECULAR, INK, prompt.accent)
	draw_string(BOLD_FONT, rect.position + Vector2(3.0, 14.0), prompt.label, HORIZONTAL_ALIGNMENT_CENTER, rect.size.x - 6.0, 11, INK)


func draw_world_interface() -> void:
	var state := scene_state()
	if state in ["need-disclosed", "mix-feedback"]:
		draw_world_label(Rect2(45.0, 168.0, 48.0, 18.0), "EMBER", EMBER)
		draw_world_label(Rect2(47.0, 190.0, 41.0, 18.0), "MOSS", SOOTHING)
	if state == "followup-selection":
		var sun_near := player_position.distance_to(FOLLOWUP_SUN_POS) <= 25.0
		var herb_near := player_position.distance_to(FOLLOWUP_HERB_POS) <= 25.0
		draw_info_sign(Rect2(250.0, 151.0, 58.0, 34.0), "Sunmill", "3W · 0S", WARMTH, sun_near or followup_choice == "sunmill_cough", followup_choice == "herbalist_chill")
		draw_info_sign(Rect2(407.0, 151.0, 67.0, 34.0), "Herbalist", "1W · 2S", SOOTHING, herb_near or followup_choice == "herbalist_chill", followup_choice == "sunmill_cough")
	var prompt := current_context_prompt()
	if not prompt.is_empty():
		draw_world_action_cue(prompt)


func draw_screen_interface() -> void:
	var state := scene_state()
	if state == "pre-disclosure":
		draw_authored_panel(Rect2(6.0, 3.0, 142.0, 65.0))
		draw_string(BOLD_FONT, Vector2(12.0, 21.0), "Morning round", HORIZONTAL_ALIGNMENT_LEFT, -1, 11, INK)
		draw_string(BODY_FONT, Vector2(12.0, 42.0), "Talk to your partner", HORIZONTAL_ALIGNMENT_LEFT, -1, 12, INK)
		return
	if state == "followup-selection":
		draw_authored_panel(Rect2(6.0, 3.0, 142.0, 65.0))
		draw_string(BOLD_FONT, Vector2(12.0, 21.0), "Next delivery", HORIZONTAL_ALIGNMENT_LEFT, -1, 11, INK)
		draw_string(BODY_FONT, Vector2(12.0, 41.0), "Walk to a pennant", HORIZONTAL_ALIGNMENT_LEFT, -1, 12, INK)
		draw_string(BODY_FONT, Vector2(12.0, 58.0), "Gust shifts·cover holds", HORIZONTAL_ALIGNMENT_LEFT, 132.0, 11, INK)
		return
	draw_request_status(state in ["satisfied-delivery", "imperfect-recovery"])
	if state in ["route-pending", "exposed-conversion", "sheltered-preservation"]:
		draw_carried_status()
	if state == "mix-feedback":
		var brew := calculate_brew(contributions)
		draw_feedback_panel("%s added" % last_ingredient.capitalize(), "Brew: %d Warmth · %d Soothing" % [brew.warm, brew.soothing])
	elif state == "exposed-conversion":
		draw_feedback_panel("Gust changed the bottle", "+1 Warmth · −1 Soothing")
	elif state == "sheltered-preservation":
		draw_feedback_panel("Shelter preserved", "%d Warmth · %d Soothing" % [bottled_state.warm, bottled_state.soothing], 254.0)
	elif state in ["satisfied-delivery", "imperfect-recovery"]:
		draw_reaction_label()
		draw_comparison()


func factory_setup(parameters: Dictionary) -> void:
	reset_gameplay()
	factory_mode = true
	scenario_mode = str(parameters.get("mode", ""))
	scenario_seed = int(parameters.get("seed", 0))
	factory_hz = maxi(1, int(parameters.get("physics_hz", 60)))
	evidence_dir = str(parameters.get("evidence_dir", ""))
	if not evidence_dir.is_empty():
		DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(evidence_dir))
	if scenario_mode not in ["first-session", "returning-player"]:
		setup_violation = "Unsupported scenario mode: %s" % scenario_mode
		return
	# Setup disclosures belong to tick zero so they survive in runner telemetry.
	factory_tick_index = 0
	current_input = {"kind": "fixture_setup", "x": 0.0, "y": 0.0, "action": "reset"}
	if scenario_mode == "returning-player":
		learned_relationship = "Prior lesson: exposed converts one soothing to warm; shelter preserves."
		record_event("returning_prerequisite_seeded", {"retained_knowledge": learned_relationship, "gameplay_state_seeded": false})
	else:
		record_event("clean_start_reset", {"retained_knowledge": "", "gameplay_state_seeded": false})
	start_motion_beat("opening")
	build_factory_actions()
	record_event("initial_state", {
		"mode": scenario_mode, "need_active": false, "contributions": [], "carrying": false,
		"route": "", "reaction": "", "available_world_choices": ["ember", "moss", "exposed", "sheltered"]
	})


func reset_gameplay() -> void:
	elapsed = 0.0
	player_position = Vector2(130.0, 165.0)
	need_active = false
	contributions.clear()
	bottled = false
	bottled_state = {"warm": 0, "soothing": 0}
	carrying = false
	chosen_route = ""
	route_delta = {"warm": 0, "soothing": 0}
	delivered_state = {"warm": 0, "soothing": 0}
	reaction = ""
	reaction_cause = ""
	learned_relationship = ""
	followup_options.clear()
	followup_choice = ""
	selected_followup.clear()
	feedback_line = "Walk with WASD / arrows. SPACE or E acts."
	move_direction = Vector2.DOWN
	courier_is_moving = false
	active_motion_beat = "opening"
	motion_beat_started_at = 0.0
	last_ingredient = ""
	factory_tick_index = -1
	factory_action_index = 0
	trace.clear()
	events_this_tick.clear()
	setup_violation = ""
	route_sample_bucket = -1
	post_reaction_move_recorded = false
	evidence_dir = ""
	captured_paths.clear()
	motion_frame_paths.clear()
	last_motion_capture_tick = -1
	pending_captures.clear()


func build_factory_actions() -> void:
	factory_actions = [
		{"target": PARTNER_POS, "interact": true, "label": "read_need"},
		{"target": EMBER_POS, "interact": true, "label": "choose_ember"},
		{"target": MOSS_POS, "interact": true, "label": "choose_moss"},
		{"target": MOSS_POS, "interact": true, "label": "choose_second_moss"},
		{"target": CAULDRON_POS, "interact": true, "label": "commit_brew"}
	]
	if scenario_mode == "first-session":
		factory_actions.append_array([
			{"target": Vector2(218.0, 96.0), "interact": false, "label": "approach_exposed"},
			{"target": Vector2(306.0, 96.0), "interact": false, "label": "cross_exposed"}
		])
	else:
		factory_actions.append_array([
			{"target": Vector2(218.0, 190.0), "interact": false, "label": "approach_shelter"},
			{"target": Vector2(306.0, 190.0), "interact": false, "label": "cross_shelter"}
		])
	factory_actions.append({"target": RECIPIENT_POS, "interact": true, "label": "deliver"})
	factory_actions.append({
		"target": FOLLOWUP_SUN_POS if scenario_mode == "first-session" else FOLLOWUP_HERB_POS,
		"interact": true,
		"label": "choose_followup"
	})


func factory_tick(tick: int) -> void:
	factory_tick_index = tick
	if tick > 0:
		events_this_tick.clear()
	if active_motion_beat.ends_with("handoff") and motion_beat_age() < 1.15:
		courier_is_moving = false
		current_input = {"kind": "none", "x": 0.0, "y": 0.0, "action": "reaction_hold"}
		return
	if not setup_violation.is_empty() or factory_action_index >= factory_actions.size():
		courier_is_moving = false
		current_input = {"kind": "none", "x": 0.0, "y": 0.0, "action": ""}
		return
	var step := factory_actions[factory_action_index]
	var target: Vector2 = step.target
	var distance := player_position.distance_to(target)
	if distance > 2.2:
		move_courier(player_position.direction_to(target), 1.0 / float(factory_hz), "replayed_shipping_axis")
		return
	player_position = target
	if bool(step.interact):
		courier_is_moving = false
		perform_context_action("replayed_shipping_context_action")
	else:
		courier_is_moving = false
		current_input = {"kind": "replayed_shipping_axis", "x": 0.0, "y": 0.0, "action": "waypoint_reached"}
		record_event("navigation_checkpoint", {"checkpoint": step.label})
	factory_action_index += 1


func factory_sample() -> Dictionary:
	capture_causal_frame()
	capture_motion_frame()
	return {
		"scenario": scenario_mode,
		"seed": scenario_seed,
		"input": current_input.duplicate(true),
		"position": {"x": snappedf(player_position.x, 0.01), "y": snappedf(player_position.y, 0.01)},
		"need_state": need.duplicate() if need_active else {},
		"ingredient_events": contributions.duplicate(),
		"bottled_state": bottled_state.duplicate(),
		"route_availability": ["exposed", "sheltered"] if carrying and chosen_route.is_empty() else [],
		"route_selection": chosen_route,
		"route_delta": route_delta.duplicate(),
		"delivered_state": delivered_state.duplicate(),
		"reaction_cause": reaction_cause,
		"followup_alternatives": followup_options.duplicate(),
		"followup_selection": followup_choice,
		"selected_followup": selected_followup.duplicate(true),
		"events": events_this_tick.duplicate(true)
	}


func capture_causal_frame() -> void:
	if evidence_dir.is_empty():
		return
	if pending_captures.is_empty() or factory_tick_index < int(pending_captures[0].due_tick):
		return
	var pending: Dictionary = pending_captures.pop_front()
	var path := evidence_dir.path_join("%02d-%s.png" % [captured_paths.size() + 1, pending.event])
	var image: Image = get_viewport().get_texture().get_image()
	if image == null:
		setup_violation = "Engine capture returned no viewport image for %s." % path
		return
	var error := image.save_png(ProjectSettings.globalize_path(path))
	if error == OK:
		captured_paths.append(path)
	else:
		setup_violation = "Engine capture failed for %s (error %d)." % [path, error]


func capture_motion_frame() -> void:
	if evidence_dir.is_empty() or factory_tick_index < 0 or factory_tick_index % 6 != 0 or factory_tick_index == last_motion_capture_tick:
		return
	last_motion_capture_tick = factory_tick_index
	var motion_dir := evidence_dir.path_join("motion-frames")
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(motion_dir))
	var path := motion_dir.path_join("frame-%04d.png" % factory_tick_index)
	var image: Image = get_viewport().get_texture().get_image()
	if image == null:
		setup_violation = "Motion capture returned no viewport image for %s." % path
		return
	var error := image.save_png(ProjectSettings.globalize_path(path))
	if error == OK:
		motion_frame_paths.append(path)
	else:
		setup_violation = "Motion capture failed for %s (error %d)." % [path, error]


func event_count(event_name: String) -> int:
	var count := 0
	for item in trace:
		if item.event == event_name:
			count += 1
	return count


func has_causal_chain() -> bool:
	var required := ["need_disclosed", "brew_committed", "route_navigation_sample", "route_selected", "delivery_resolved", "followup_requests_disclosed", "followup_navigation_sample", "followup_selected"]
	var cursor := -1
	for required_event in required:
		var found := -1
		for index in range(cursor + 1, trace.size()):
			if trace[index].event == required_event:
				found = index
				break
		if found < 0:
			return false
		cursor = found
	return true


func first_event(event_name: String) -> Dictionary:
	for item in trace:
		if item.event == event_name:
			return item
	return {}


func navigation_agency_is_trace_grounded() -> bool:
	var commit := first_event("brew_committed")
	var route_move := first_event("route_navigation_sample")
	var selection := first_event("route_selected")
	if commit.is_empty() or route_move.is_empty() or selection.is_empty():
		return false
	var alternatives: Dictionary = commit.get("route_alternatives", {})
	var pre_route: Dictionary = selection.get("pre_route", {})
	var delta: Dictionary = selection.get("delta", {})
	var post_route: Dictionary = selection.get("post_route", {})
	var derived_post := {
		"warm": int(pre_route.get("warm", 0)) + int(delta.get("warm", 0)),
		"soothing": int(pre_route.get("soothing", 0)) + int(delta.get("soothing", 0))
	}
	var selected_by_position: bool = (selection.route == "exposed" and float(selection.position.y) < 136.0) or (selection.route == "sheltered" and float(selection.position.y) >= 136.0)
	var axis_input: Dictionary = route_move.get("input", {})
	var direct_axis := str(axis_input.get("kind", "")).contains("axis") and (absf(float(axis_input.get("x", 0.0))) > 0.0 or absf(float(axis_input.get("y", 0.0))) > 0.0)
	var consequence_valid: bool = (selection.route == "exposed" and delta != {"warm": 0, "soothing": 0}) or (selection.route == "sheltered" and delta == {"warm": 0, "soothing": 0})
	return alternatives.size() == 2 and direct_axis and selected_by_position and consequence_valid and post_route == derived_post


func followup_choice_is_trace_grounded() -> bool:
	var disclosed := first_event("followup_requests_disclosed")
	var movement := first_event("followup_navigation_sample")
	var selected := first_event("followup_selected")
	if disclosed.is_empty() or movement.is_empty() or selected.is_empty():
		return false
	var requests: Dictionary = disclosed.get("requests", {})
	if requests.size() != 2 or not requests.has(followup_choice):
		return false
	var sun: Dictionary = requests.get("sunmill_cough", {})
	var herb: Dictionary = requests.get("herbalist_chill", {})
	var distinct_needs: bool = sun.get("need", {}) != herb.get("need", {})
	var distinct_plans: bool = sun.get("route_plan", "") != herb.get("route_plan", "")
	var chosen_profile: Dictionary = requests[followup_choice]
	return distinct_needs and distinct_plans and not learned_relationship.is_empty() and selected.get("prior_reaction", "") == reaction and selected.get("selected_request", {}) == chosen_profile and selected.get("resulting_plan", "") == chosen_profile.get("route_plan", "")


func factory_collect() -> Dictionary:
	var violations: Array[Dictionary] = []
	if not setup_violation.is_empty():
		violations.append({"code": "gameplay.scenario_mode", "message": setup_violation, "severity": "error"})
	var chain_ok := has_causal_chain()
	var expected_delivered := state_after_route()
	var state_link_ok := not chosen_route.is_empty() and delivered_state == expected_delivered
	var expected_reaction := "satisfied" if delivered_state == need else "imperfect"
	var reaction_ok := not reaction.is_empty() and reaction == expected_reaction and reaction_cause.contains("W%d / S%d" % [delivered_state.warm, delivered_state.soothing])
	var distinct_ingredients := contributions.has("ember") and contributions.has("moss")
	var route_expected := (scenario_mode == "first-session" and chosen_route == "exposed") or (scenario_mode == "returning-player" and chosen_route == "sheltered")
	var scenario_outcome_ok := (scenario_mode == "first-session" and reaction == "satisfied") or (scenario_mode == "returning-player" and reaction == "imperfect")
	var navigation_agency_ok := navigation_agency_is_trace_grounded()
	var followup_ok := followup_choice_is_trace_grounded()
	var invalid_transitions := event_count("invalid_bottle") + event_count("invalid_delivery") + event_count("invalid_context_action")
	if not chain_ok:
		violations.append({"code": "gameplay.causal_chain", "message": "Missing or out-of-order decision-to-feedback event.", "severity": "error"})
	if not state_link_ok:
		violations.append({"code": "gameplay.delivered_state", "message": "Delivered qualities do not derive from bottled state plus route delta.", "severity": "error"})
	if not reaction_ok:
		violations.append({"code": "gameplay.reaction", "message": "Reaction is absent or not attributed to the delivered qualities.", "severity": "error"})
	if not distinct_ingredients:
		violations.append({"code": "gameplay.brew_choice", "message": "Scenario did not exercise distinguishable ingredient alternatives.", "severity": "error"})
	if not route_expected:
		violations.append({"code": "gameplay.route_choice", "message": "Scenario did not traverse its configured route alternative.", "severity": "error"})
	if not scenario_outcome_ok:
		violations.append({"code": "gameplay.counterfactual", "message": "Configured route did not produce its state-derived counterfactual outcome.", "severity": "error"})
	if not followup_ok:
		violations.append({"code": "gameplay.next_choice", "message": "Attributed feedback did not reach a follow-up decision.", "severity": "error"})
	if not navigation_agency_ok:
		violations.append({"code": "gameplay.navigation_agency", "message": "Route alternatives, direct axis movement, position-caused selection, and state consequence are not linked in the trace.", "severity": "error"})
	if invalid_transitions > 0:
		violations.append({"code": "gameplay.invalid_transition", "message": "The evidence replay attempted an invalid gameplay transition.", "severity": "error"})
	if not evidence_dir.is_empty() and captured_paths.size() != 5:
		violations.append({"code": "gameplay.engine_capture", "message": "Expected five ordered causal captures but preserved %d." % captured_paths.size(), "severity": "error"})
	if not evidence_dir.is_empty() and motion_frame_paths.size() < 120:
		violations.append({"code": "motion.engine_capture", "message": "Expected at least 120 shipping-speed motion frames but preserved %d." % motion_frame_paths.size(), "severity": "error"})
	var consequential_choices := event_count("brew_committed") + event_count("route_selected") + event_count("followup_selected")
	var complete := violations.is_empty()
	var result := {
		"metrics": {
			"completion": 1 if complete else 0,
			"concept_defined": 1 if event_count("need_disclosed") == 1 else 0,
			"mechanic_proven": 1 if complete else 0,
			"meaningful_interactions": consequential_choices,
			"consequential_choices": consequential_choices,
			"clean_start_loop_complete": 1 if complete and scenario_mode == "first-session" else 0,
			"returning_loop_complete": 1 if complete and scenario_mode == "returning-player" else 0,
			"delivered_state_trace_grounded": 1 if state_link_ok else 0,
			"reaction_trace_grounded": 1 if reaction_ok else 0,
			"followup_choice_trace_grounded": 1 if followup_ok else 0,
			"motion_frames_captured": motion_frame_paths.size(),
			"causal_events": trace.size(),
			"invalid_transitions": invalid_transitions,
			"navigation_is_agency": 1 if navigation_agency_ok else 0
		},
		"violations": violations
	}
	if not write_review_report(result):
		result.violations.append({"code": "gameplay.review_report", "message": "Could not preserve the scenario review report.", "severity": "error"})
		result.metrics.completion = 0
		result.metrics.mechanic_proven = 0
		result.metrics.clean_start_loop_complete = 0
		result.metrics.returning_loop_complete = 0
	return result


func write_review_report(result: Dictionary) -> bool:
	if evidence_dir.is_empty():
		return true
	var report_path := evidence_dir.path_join("scenario-review.json")
	var file := FileAccess.open(ProjectSettings.globalize_path(report_path), FileAccess.WRITE)
	if not file:
		return false
	var report := {
		"scenario": scenario_mode,
		"seed": scenario_seed,
		"initial_state": first_event("initial_state"),
		"mode_setup": first_event("clean_start_reset") if scenario_mode == "first-session" else first_event("returning_prerequisite_seeded"),
		"decisions_and_alternatives": {
			"brew": first_event("brew_committed"), "route": first_event("route_selected"),
			"followup_disclosure": first_event("followup_requests_disclosed"), "followup_selection": first_event("followup_selected")
		},
		"causal_events": trace.duplicate(true),
		"carried_state": {"committed": bottled_state, "route_delta": route_delta, "delivered": delivered_state, "consumed_by_reaction": not reaction.is_empty()},
		"metrics": result.metrics,
		"metric_trace_sources": {
			"completion": "ordered causal events plus zero violations", "consequential_choices": "brew_committed + route_selected + followup_selected",
			"navigation_is_agency": "brew_committed.route_alternatives + route_navigation_sample.input + route_selected position/pre/delta/post",
			"followup_choice_trace_grounded": "delivery_resolved + followup_requests_disclosed + followup_navigation_sample + followup_selected"
		},
		"violations": result.violations, "engine_errors": [],
		"artifact_paths": captured_paths.duplicate(),
		"motion_frame_paths": motion_frame_paths.duplicate()
	}
	file.store_string(JSON.stringify(report, "  ") + "\n")
	return true
