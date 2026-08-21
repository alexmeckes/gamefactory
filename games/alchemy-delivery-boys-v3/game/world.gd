extends Node2D

var selected_mix: String = "fizz_forward"
var delivery_complete: bool = false
var follow_up_choice: String = ""
var last_reaction: String = ""

@onready var player: CharacterBody2D = $Player
@onready var status_label: Label = $HUD/Status
@onready var feedback_label: Label = $HUD/Feedback
@onready var follow_warm: Node2D = $FollowWarmCooling
@onready var follow_fizz: Node2D = $FollowFizzVenting


func _ready() -> void:
	show_feedback("Read the need, choose WARM or FIZZ, then brew. WASD / arrows move; E / Space interacts.")
	update_hud(player)
	queue_redraw()


func on_brew_committed(courier: CharacterBody2D) -> void:
	show_feedback("Bottle mixed by hand. Now carry it through exactly one lane: COOL or VENT.")
	update_hud(courier)


func on_route_applied(courier: CharacterBody2D, effect_id: String) -> void:
	var consequence := "warmth -1" if effect_id == "cooling" else "fizz -1"
	show_feedback("Journey changed the carried bottle: %s (%s). Deliver it to Mira." % [effect_id, consequence])
	update_hud(courier)


func resolve_reaction(warmth: int, fizz: int) -> String:
	if warmth == 2 and fizz == 2:
		return "balanced relief"
	if warmth < 2 and fizz > 2:
		return "too cool and too fizzy"
	if warmth > 2 and fizz < 2:
		return "too warm and too flat"
	if warmth < 2:
		return "too cool"
	if warmth > 2:
		return "too warm"
	if fizz < 2:
		return "too flat"
	return "too fizzy"


func on_delivery(courier: CharacterBody2D, reaction: String) -> void:
	delivery_complete = true
	last_reaction = reaction
	follow_warm.active = true
	follow_fizz.active = true
	follow_warm.queue_redraw()
	follow_fizz.queue_redraw()
	var lesson := "Mira steadies: balanced warmth and fizz arrived together."
	if reaction != "balanced relief":
		lesson = "Mira reacts: %s. The result came from your mix plus the %s lane." % [reaction, courier.route_effect]
	show_feedback("%s Choose a next-batch prediction below." % lesson)
	update_hud(courier)


func commit_follow_up(target: Node2D, courier: CharacterBody2D) -> void:
	follow_up_choice = target.plan_id
	target.selected = true
	var other: Node2D = follow_fizz if target == follow_warm else follow_warm
	other.active = false
	other.queue_redraw()
	show_feedback("Next plan committed: %s. You used the delivery result to make another choice." % follow_up_choice.replace("_", " + "))
	update_hud(courier)


func show_feedback(message: String) -> void:
	feedback_label.text = message


func update_hud(courier: CharacterBody2D) -> void:
	var plan := selected_mix.replace("_", " ")
	var bottle: String = courier.potion_description()
	var outcome := "awaiting delivery" if last_reaction.is_empty() else last_reaction
	if not follow_up_choice.is_empty():
		outcome = "%s -> next: %s" % [outcome, follow_up_choice.replace("_", " + ")]
	status_label.text = "MIRA'S NEED: balanced warmth + fizz    PLAN: %s\nBOTTLE: %s    RESULT: %s" % [plan, bottle, outcome]


func _draw() -> void:
	draw_rect(Rect2(0, 0, 480, 270), Color("171525"), true)
	draw_rect(Rect2(14, 36, 300, 219), Color("243047"), true)
	draw_rect(Rect2(336, 36, 130, 219), Color("34243d"), true)
	for x in range(28, 470, 24):
		for y in range(48, 260, 24):
			draw_circle(Vector2(x, y), 0.8, Color("4a5875"))
	# Workshop/village divide. The only openings are the two transformative lanes.
	draw_rect(Rect2(318, 36, 12, 45), Color("725a48"), true)
	draw_rect(Rect2(318, 125, 12, 18), Color("725a48"), true)
	draw_rect(Rect2(318, 187, 12, 68), Color("725a48"), true)
	draw_string(ThemeDB.fallback_font, Vector2(22, 49), "WORKSHOP", HORIZONTAL_ALIGNMENT_LEFT, -1, 9, Color("b8a1d9"))
	draw_string(ThemeDB.fallback_font, Vector2(357, 49), "MIRA'S GARDEN", HORIZONTAL_ALIGNMENT_LEFT, -1, 9, Color("d8a47f"))
	draw_string(ThemeDB.fallback_font, Vector2(100, 203), "CHOOSE MIX", HORIZONTAL_ALIGNMENT_LEFT, -1, 7, Color("8ea4c9"))
	draw_string(ThemeDB.fallback_font, Vector2(357, 232), "AFTER DELIVERY: CHOOSE", HORIZONTAL_ALIGNMENT_LEFT, -1, 7, Color("d8a47f"))
