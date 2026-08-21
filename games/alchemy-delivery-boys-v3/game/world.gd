extends Node2D

var selected_mix: String = "fizz_forward"
var delivery_complete: bool = false
var follow_up_choice: String = ""
var last_reaction: String = ""

@onready var player: CharacterBody2D = $Player
@onready var hud: CanvasLayer = $HUD
@onready var brew_station: Node2D = $BrewStation
@onready var cooling_lane: Area2D = $CoolingLane
@onready var venting_lane: Area2D = $VentingLane
@onready var villager: Node2D = $Villager
@onready var follow_warm: Node2D = $FollowWarmCooling
@onready var follow_fizz: Node2D = $FollowFizzVenting


func _ready() -> void:
	show_feedback("CHOOSE WARM OR FIZZ, THEN BREW · WASD MOVE · E INTERACT", "controls")
	update_hud(player)


func on_brew_committed(courier: CharacterBody2D) -> void:
	show_feedback("BOTTLE SETTLED · CARRY THROUGH EXACTLY ONE GATE: COOL OR VENT", "feedback")
	update_hud(courier)


func on_route_applied(courier: CharacterBody2D, effect_id: String) -> void:
	if effect_id == "cooling":
		show_feedback("COOL REDUCED WARMTH · DELIVER THE CHANGED BOTTLE TO MIRA", "feedback")
	else:
		show_feedback("VENT RELEASED FIZZ · DELIVER THE CHANGED BOTTLE TO MIRA", "feedback")
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
	update_hud(courier)
	show_feedback("MIRA RECEIVES THE ROUTED BOTTLE · WATCH HER RESPONSE", "feedback")
	await get_tree().create_timer(0.90).timeout
	if not is_instance_valid(follow_warm) or not is_instance_valid(follow_fizz):
		return
	follow_warm.activate()
	follow_fizz.activate()
	var lesson := "MIRA STEADIES · CHOOSE YOUR NEXT-BATCH PREDICTION"
	if reaction != "balanced relief":
		lesson = "MIRA SHOWS %s · CHOOSE WHAT TO TRY NEXT" % reaction.to_upper()
	show_feedback(lesson, "resolved")


func commit_follow_up(target: Node2D, courier: CharacterBody2D) -> void:
	follow_up_choice = target.plan_id
	target.select()
	var other: Node2D = follow_fizz if target == follow_warm else follow_warm
	other.disable()
	courier.play_choose()
	show_feedback("NEXT PLAN COMMITTED · THE RESULT INFORMED ANOTHER CHOICE", "resolved")
	update_hud(courier)


func show_feedback(message: String, state: String = "feedback") -> void:
	hud.show_feedback(message, state)


func show_recovery(message: String) -> void:
	hud.show_feedback(message, "recovery")
	if player.carrying and player.route_effect.is_empty():
		cooling_lane.pulse_recovery()
		venting_lane.pulse_recovery()
	elif player.carrying:
		villager.pulse_recovery()
	elif delivery_complete and follow_up_choice.is_empty():
		follow_warm.pulse_recovery()
		follow_fizz.pulse_recovery()
	elif not delivery_complete:
		brew_station.pulse_recovery()


func update_hud(courier: CharacterBody2D) -> void:
	var need := "MIRA · BALANCE"
	var middle := "PLAN · %s" % ("WARM" if selected_mix == "warm_forward" else "FIZZ")
	var right := "BOTTLE · %s" % courier.bottle_short()
	var state := "normal"
	if not last_reaction.is_empty():
		middle = "RESULT · %s" % _reaction_short(last_reaction)
		right = "BOTTLE · NONE"
		state = "resolved"
	if not follow_up_choice.is_empty():
		right = "NEXT · %s" % ("WARM+COOL" if follow_up_choice == "warm_cooling" else "FIZZ+VENT")
	hud.set_status(need, middle, right, state)


func _reaction_short(value: String) -> String:
	if value == "balanced relief":
		return "BALANCED"
	return value.to_upper().replace("TOO ", "")
