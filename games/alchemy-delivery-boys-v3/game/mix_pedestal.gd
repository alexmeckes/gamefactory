extends Node2D

const WorldCue := preload("res://game/ui/production/inkcap-conservatory/world_cue.gd")
const WARM_TEXTURE := preload("res://game/assets/production/inkcap-conservatory/interactables/warm-ingredient.png")
const FIZZ_TEXTURE := preload("res://game/assets/production/inkcap-conservatory/interactables/fizz-ingredient.png")
const DISPLAY_FONT := preload("res://game/assets/production/inkcap-conservatory/interface/fonts/DejaVuSans-Bold.ttf")

@export_enum("warm_forward", "fizz_forward") var mix_id: String = "warm_forward"

var _focused: bool = false
var _feedback_time: float = 0.0
var _cue: Node2D

@onready var visual: Sprite2D = $Visual


func _ready() -> void:
	add_to_group("interactable")
	visual.texture = WARM_TEXTURE if mix_id == "warm_forward" else FIZZ_TEXTURE
	visual.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	var identity := Label.new()
	identity.position = Vector2(-18, 7)
	identity.size = Vector2(36, 10)
	identity.text = "WARM" if mix_id == "warm_forward" else "FIZZ"
	identity.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	identity.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	identity.add_theme_font_override("font", DISPLAY_FONT)
	identity.add_theme_font_size_override("font_size", 6)
	identity.add_theme_color_override("font_color", Color("ef8aa3") if mix_id == "warm_forward" else Color("8ceaf3"))
	identity.add_theme_color_override("font_shadow_color", Color("12121f"))
	identity.add_theme_constant_override("shadow_offset_x", 1)
	identity.add_theme_constant_override("shadow_offset_y", 1)
	identity.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(identity)
	_cue = WorldCue.new()
	var label := "WARM [E]" if mix_id == "warm_forward" else "FIZZ [E]"
	var color := Color("ef476f") if mix_id == "warm_forward" else Color("66d9e8")
	_cue.configure(label, Vector2(-24, -48), color)
	add_child(_cue)


func _process(delta: float) -> void:
	_feedback_time = maxf(0.0, _feedback_time - delta)
	var selected: bool = get_parent().selected_mix == mix_id
	visual.frame = 3 if _feedback_time > 0.0 else (2 if selected else (1 if _focused else 0))
	visual.position = Vector2(0, -11 if _focused else -10)


func interact(player: CharacterBody2D) -> void:
	var world := get_parent()
	if player.carrying or world.delivery_complete:
		world.show_recovery("CHOOSE INGREDIENTS BEFORE THE NEXT BREW")
		return
	world.selected_mix = mix_id
	_feedback_time = 0.28
	world.show_feedback("PLAN SET · %s · REACH THE CAULDRON AND BREW" % mix_id.replace("_", " "), "feedback")
	world.update_hud(player)


func set_focus(value: bool) -> void:
	_focused = value
	_cue.set_focused(value)


func press_cue() -> void:
	_cue.press()


func pulse_recovery() -> void:
	_cue.pulse_recovery()
