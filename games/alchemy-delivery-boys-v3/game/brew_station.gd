extends Node2D

const WorldCue := preload("res://game/ui/production/inkcap-conservatory/world_cue.gd")
const DISPLAY_FONT := preload("res://game/assets/production/inkcap-conservatory/interface/fonts/DejaVuSans-Bold.ttf")

@export var brew_committed: bool = false

var _beat_time: float = 0.0
var _focused: bool = false
var _cue: Node2D

@onready var visual: Sprite2D = $Visual
@onready var effect: Sprite2D = $Effect


func _ready() -> void:
	add_to_group("interactable")
	visual.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	effect.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	var identity := Label.new()
	identity.position = Vector2(-19, 2)
	identity.size = Vector2(38, 10)
	identity.text = "BREW"
	identity.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	identity.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	identity.add_theme_font_override("font", DISPLAY_FONT)
	identity.add_theme_font_size_override("font_size", 6)
	identity.add_theme_color_override("font_color", Color("d9c2ff"))
	identity.add_theme_color_override("font_shadow_color", Color("12121f"))
	identity.add_theme_constant_override("shadow_offset_x", 1)
	identity.add_theme_constant_override("shadow_offset_y", 1)
	identity.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(identity)
	_cue = WorldCue.new()
	_cue.configure("BREW [E]", Vector2(-24, -58), Color("7f5af0"))
	add_child(_cue)


func _process(delta: float) -> void:
	_beat_time = maxf(0.0, _beat_time - delta)
	if _beat_time > 0.0:
		var progress := 1.0 - _beat_time / 0.45
		visual.frame = clampi(int(floor(progress * 5.0)) + 1, 1, 4)
		effect.visible = true
		effect.frame = clampi(int(floor(progress * 5.0)), 0, 4)
	else:
		visual.frame = 5 if brew_committed else (1 if _focused else 0)
		effect.visible = false


func interact(player: CharacterBody2D) -> void:
	var world := get_parent()
	if player.carrying:
		world.show_recovery("HANDS FULL · CROSS COOL OR VENT")
		return
	if world.delivery_complete:
		world.show_recovery("DELIVERY COMPLETE · CHOOSE A GARDEN PLOT")
		return
	brew_committed = true
	_beat_time = 0.45
	if world.selected_mix == "warm_forward":
		player.load_potion("warm_forward", 3, 2)
	else:
		player.load_potion("fizz_forward", 2, 3)
	world.on_brew_committed(player)


func set_focus(value: bool) -> void:
	_focused = value
	_cue.set_focused(value)


func press_cue() -> void:
	_cue.press()


func pulse_recovery() -> void:
	_cue.pulse_recovery()
