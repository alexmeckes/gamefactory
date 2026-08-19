extends Node2D

const VIEW_SIZE := Vector2(480.0, 270.0)
const MOVE_SPEED := 118.0
const INTERACT_RANGE := 28.0

const PARTNER_POS := Vector2(67.0, 122.0)
const EMBER_POS := Vector2(104.0, 214.0)
const MOSS_POS := Vector2(174.0, 214.0)
const CAULDRON_POS := Vector2(143.0, 158.0)
const RECIPIENT_POS := Vector2(423.0, 137.0)
const FOLLOWUP_SUN_POS := Vector2(397.0, 79.0)
const FOLLOWUP_HERB_POS := Vector2(450.0, 79.0)
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
var player_position := Vector2(72.0, 178.0)
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
		current_input = {"kind": "none", "x": 0.0, "y": 0.0, "action": ""}
	if Input.is_key_pressed(KEY_SPACE) or Input.is_key_pressed(KEY_E):
		if not get_meta("action_latched", false):
			set_meta("action_latched", true)
			perform_context_action("player_context_action")
	else:
		set_meta("action_latched", false)


func move_courier(direction: Vector2, delta: float, input_kind: String) -> void:
	var normalized := direction.normalized()
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
		record_event("need_disclosed", {
			"target": "partner", "need": need.duplicate(),
			"alternatives": ["ember adds warm", "moss adds soothing"]
		})
		return true
	if need_active and not bottled and player_position.distance_to(EMBER_POS) <= INTERACT_RANGE:
		add_ingredient("ember")
		return true
	if need_active and not bottled and player_position.distance_to(MOSS_POS) <= INTERACT_RANGE:
		add_ingredient("moss")
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
	var preview := calculate_brew(contributions)
	feedback_line = "%s added: brew now W%d / S%d." % [ingredient.capitalize(), preview.warm, preview.soothing]
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
	else:
		chosen_route = "sheltered"
		route_delta = {"warm": 0, "soothing": 0}
		feedback_line = "SHELTER preserved the bottled qualities."
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


func _draw() -> void:
	# Every runtime surface is intentionally code-native prototype graybox geometry.
	draw_rect(Rect2(0, 0, 480, 270), Color("17202a"))
	draw_rect(Rect2(8, 38, 464, 222), Color("26323b"), true)
	draw_rect(Rect2(22, 91, 210, 150), Color("344638"), true)
	draw_rect(Rect2(232, 48, 143, 88), Color("4b5664"), true)
	draw_rect(Rect2(232, 136, 143, 105), Color("39483f"), true)
	draw_line(Vector2(232, 136), Vector2(375, 136), Color("d4aa5a"), 2.0)
	draw_string(ThemeDB.fallback_font, Vector2(10, 21), "PROTOTYPE GRAYBOX — NOT PRODUCTION ART", HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color("f4d88a"))
	draw_string(ThemeDB.fallback_font, Vector2(10, 34), "Direct movement + one context action", HORIZONTAL_ALIGNMENT_LEFT, -1, 9, Color("aebbc5"))

	marker(PARTNER_POS, Color("e8c36a"), "PARTNER / NEED")
	marker(EMBER_POS, Color("e56b4b"), "EMBER +W")
	marker(MOSS_POS, Color("73b987"), "MOSS +S")
	marker(CAULDRON_POS, Color("8b79ad"), "CAULDRON / BOTTLE")
	marker(RECIPIENT_POS, Color("efb6a7"), "MIRA / DELIVER")
	draw_string(ThemeDB.fallback_font, Vector2(248, 63), "EXPOSED: 1 S -> 1 W", HORIZONTAL_ALIGNMENT_LEFT, -1, 9, Color("dbe7f0"))
	draw_string(ThemeDB.fallback_font, Vector2(248, 228), "SHELTER: PRESERVE", HORIZONTAL_ALIGNMENT_LEFT, -1, 9, Color("d7e8cc"))
	if not reaction.is_empty():
		marker(FOLLOWUP_SUN_POS, Color("efc95e"), "")
		marker(FOLLOWUP_HERB_POS, Color("85c898"), "")
		draw_string(ThemeDB.fallback_font, Vector2(378, 61), "SUN W3/S0", HORIZONTAL_ALIGNMENT_LEFT, -1, 7, Color("f3f5f4"))
		draw_string(ThemeDB.fallback_font, Vector2(378, 69), "EXPOSED", HORIZONTAL_ALIGNMENT_LEFT, -1, 7, Color("efc95e"))
		draw_string(ThemeDB.fallback_font, Vector2(431, 61), "HERB W1/S2", HORIZONTAL_ALIGNMENT_LEFT, -1, 7, Color("f3f5f4"))
		draw_string(ThemeDB.fallback_font, Vector2(431, 69), "SHELTER", HORIZONTAL_ALIGNMENT_LEFT, -1, 7, Color("85c898"))

	var courier_color := Color("f5efe1")
	draw_circle(player_position, 8.0, courier_color)
	draw_circle(player_position + Vector2(0, -4), 3.0, Color("3e5261"))
	if carrying:
		draw_circle(player_position + Vector2(10, -7), 4.0, potion_color(state_after_route()))

	draw_rect(Rect2(8, 242, 464, 18), Color("11171d"), true)
	draw_string(ThemeDB.fallback_font, Vector2(14, 255), feedback_line.left(78), HORIZONTAL_ALIGNMENT_LEFT, -1, 9, Color("eef3f5"))
	var state_text := "BREW W%d/S%d -> ROUTE %s" % [bottled_state.warm, bottled_state.soothing, chosen_route if not chosen_route.is_empty() else "—"]
	draw_string(ThemeDB.fallback_font, Vector2(235, 151), state_text, HORIZONTAL_ALIGNMENT_LEFT, 230, 8, Color("f1e4bf"))
	if not reaction.is_empty():
		draw_string(ThemeDB.fallback_font, Vector2(235, 161), "ARRIVED W%d/S%d -> %s" % [delivered_state.warm, delivered_state.soothing, reaction], HORIZONTAL_ALIGNMENT_LEFT, 230, 8, Color("f1e4bf"))


func marker(position: Vector2, color: Color, label: String) -> void:
	draw_circle(position, 10.0, Color(color, 0.25))
	draw_circle(position, 5.0, color)
	if not label.is_empty():
		draw_string(ThemeDB.fallback_font, position + Vector2(-28, -13), label, HORIZONTAL_ALIGNMENT_LEFT, -1, 7, Color("f3f5f4"))


func potion_color(state: Dictionary) -> Color:
	var total: float = maxf(1.0, float(state.warm + state.soothing))
	return Color(0.35 + 0.55 * float(state.warm) / total, 0.3 + 0.55 * float(state.soothing) / total, 0.48)


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
	build_factory_actions()
	record_event("initial_state", {
		"mode": scenario_mode, "need_active": false, "contributions": [], "carrying": false,
		"route": "", "reaction": "", "available_world_choices": ["ember", "moss", "exposed", "sheltered"]
	})


func reset_gameplay() -> void:
	elapsed = 0.0
	player_position = Vector2(72.0, 178.0)
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
	factory_tick_index = -1
	factory_action_index = 0
	trace.clear()
	events_this_tick.clear()
	setup_violation = ""
	route_sample_bucket = -1
	post_reaction_move_recorded = false
	evidence_dir = ""
	captured_paths.clear()


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
			{"target": Vector2(246.0, 96.0), "interact": false, "label": "approach_exposed"},
			{"target": Vector2(306.0, 96.0), "interact": false, "label": "cross_exposed"}
		])
	else:
		factory_actions.append_array([
			{"target": Vector2(246.0, 197.0), "interact": false, "label": "approach_shelter"},
			{"target": Vector2(306.0, 197.0), "interact": false, "label": "cross_shelter"}
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
	if not setup_violation.is_empty() or factory_action_index >= factory_actions.size():
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
		perform_context_action("replayed_shipping_context_action")
	else:
		current_input = {"kind": "replayed_shipping_axis", "x": 0.0, "y": 0.0, "action": "waypoint_reached"}
		record_event("navigation_checkpoint", {"checkpoint": step.label})
	factory_action_index += 1


func factory_sample() -> Dictionary:
	capture_causal_frame()
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
	var capture_events := ["need_disclosed", "brew_committed", "route_selected", "delivery_resolved", "followup_selected"]
	for item in events_this_tick:
		if capture_events.has(item.event):
			var path := evidence_dir.path_join("%02d-%s.png" % [captured_paths.size() + 1, item.event])
			var image: Image = get_viewport().get_texture().get_image()
			if image == null:
				setup_violation = "Engine capture returned no viewport image for %s." % path
				return
			var error := image.save_png(ProjectSettings.globalize_path(path))
			if error == OK:
				captured_paths.append(path)
			else:
				setup_violation = "Engine capture failed for %s (error %d)." % [path, error]


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
		"artifact_paths": captured_paths.duplicate()
	}
	file.store_string(JSON.stringify(report, "  ") + "\n")
	return true
