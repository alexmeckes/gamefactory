extends Node2D

const WorldCue := preload("res://game/ui/production/inkcap-conservatory/world_cue.gd")
const DISPLAY_FONT := preload("res://game/assets/production/inkcap-conservatory/interface/fonts/DejaVuSans-Bold.ttf")

var reaction: String = "waiting"
var _reaction_time: float = 0.0
var _idle_time: float = 0.0
var _focused: bool = false
var _cue: Node2D

@onready var visual: Sprite2D = $Visual
@onready var effect: Sprite2D = $Effect


func _ready() -> void:
	add_to_group("interactable")
	visual.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	effect.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	var identity := Label.new()
	identity.position = Vector2(-18, 3)
	identity.size = Vector2(36, 10)
	identity.text = "MIRA"
	identity.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	identity.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	identity.add_theme_font_override("font", DISPLAY_FONT)
	identity.add_theme_font_size_override("font_size", 6)
	identity.add_theme_color_override("font_color", Color("d89b62"))
	identity.add_theme_color_override("font_shadow_color", Color("12121f"))
	identity.add_theme_constant_override("shadow_offset_x", 1)
	identity.add_theme_constant_override("shadow_offset_y", 1)
	identity.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(identity)
	_cue = WorldCue.new()
	_cue.configure("MIRA [E]", Vector2(-25, -52), Color("d89b62"))
	add_child(_cue)


func _process(delta: float) -> void:
	_idle_time += delta
	_reaction_time = maxf(0.0, _reaction_time - delta)
	if _reaction_time > 0.0:
		var elapsed := 1.14 - _reaction_time
		if elapsed < 0.24:
			visual.frame = 2
		else:
			visual.frame = 3 if reaction == "balanced relief" else 4
		effect.visible = elapsed >= 0.20 and elapsed <= 1.05
		effect.frame = clampi(int(floor((elapsed - 0.20) / 0.18)), 0, 4)
	else:
		visual.frame = 5 if reaction != "waiting" else (1 if _focused else 0)
		effect.visible = false
	# A single offset blink adds continuity without competing with focus.
	if reaction == "waiting" and not _focused and int(floor(_idle_time * 2.0)) % 17 == 16:
		visual.modulate = Color(0.88, 0.88, 1.0, 1.0)
	else:
		visual.modulate = Color.WHITE


func interact(player: CharacterBody2D) -> void:
	var world := get_parent()
	if world.delivery_complete:
		world.show_recovery("MIRA POINTS TO THE TWO GARDEN PREDICTIONS")
		return
	if not player.carrying:
		world.show_recovery("MIRA STILL NEEDS A POTION · CHOOSE AND BREW")
		return
	if player.route_effect.is_empty():
		world.show_recovery("BOTTLE UNFINISHED · CROSS COOL OR VENT")
		return
	reaction = world.resolve_reaction(player.warmth, player.fizz)
	_reaction_time = 1.14
	player.consume_potion(reaction)
	world.on_delivery(player, reaction)


func set_focus(value: bool) -> void:
	_focused = value
	_cue.set_focused(value)


func press_cue() -> void:
	_cue.press()


func pulse_recovery() -> void:
	_cue.pulse_recovery()
