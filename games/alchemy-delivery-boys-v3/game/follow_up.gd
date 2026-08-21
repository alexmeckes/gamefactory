extends Node2D

const WorldCue := preload("res://game/ui/production/inkcap-conservatory/world_cue.gd")
const WARM_COOL_TEXTURE := preload("res://game/assets/production/inkcap-conservatory/interactables/follow-up-warm_cool.png")
const FIZZ_VENT_TEXTURE := preload("res://game/assets/production/inkcap-conservatory/interactables/follow-up-fizz_vent.png")
const DISPLAY_FONT := preload("res://game/assets/production/inkcap-conservatory/interface/fonts/DejaVuSans-Bold.ttf")

@export_enum("warm_cooling", "fizz_venting") var plan_id: String = "warm_cooling"

var active: bool = false
var selected: bool = false
var disabled: bool = false
var _focused: bool = false
var _activation_time: float = 0.0
var _selection_time: float = 0.0
var _cue: Node2D
var _identity: Label

@onready var visual: Sprite2D = $Visual
@onready var effect: Sprite2D = $Effect


func _ready() -> void:
	add_to_group("interactable")
	visual.texture = WARM_COOL_TEXTURE if plan_id == "warm_cooling" else FIZZ_VENT_TEXTURE
	visual.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	effect.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_identity = Label.new()
	_identity.position = Vector2(-29, 12)
	_identity.size = Vector2(58, 10)
	_identity.text = "WARM+COOL" if plan_id == "warm_cooling" else "FIZZ+VENT"
	_identity.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_identity.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_identity.add_theme_font_override("font", DISPLAY_FONT)
	_identity.add_theme_font_size_override("font_size", 5)
	_identity.add_theme_color_override("font_color", Color("9be564") if plan_id == "warm_cooling" else Color("d89b62"))
	_identity.add_theme_color_override("font_shadow_color", Color("12121f"))
	_identity.add_theme_constant_override("shadow_offset_x", 1)
	_identity.add_theme_constant_override("shadow_offset_y", 1)
	_identity.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_identity.visible = false
	add_child(_identity)
	_cue = WorldCue.new()
	var label := "WARM+COOL [E]" if plan_id == "warm_cooling" else "FIZZ+VENT [E]"
	var color := Color("9be564") if plan_id == "warm_cooling" else Color("d89b62")
	_cue.configure(label, Vector2(-34, -43), color)
	add_child(_cue)


func _process(delta: float) -> void:
	_activation_time = maxf(0.0, _activation_time - delta)
	_selection_time = maxf(0.0, _selection_time - delta)
	if disabled:
		visual.frame = 4
	elif selected:
		visual.frame = 3
	elif not active:
		visual.frame = 0
	elif _activation_time > 0.0:
		visual.frame = 5
	else:
		visual.frame = 2 if _focused else 1
	if _selection_time > 0.0:
		var progress := 1.0 - _selection_time / 0.30
		effect.visible = true
		effect.frame = clampi(int(floor(progress * 4.0)) + 1, 1, 4)
	else:
		effect.visible = false
	_identity.visible = active
	_identity.modulate = Color(0.55, 0.52, 0.60, 1.0) if disabled else Color.WHITE


func is_available() -> bool:
	return active and not selected and not disabled


func activate() -> void:
	active = true
	_activation_time = 0.28


func select() -> void:
	selected = true
	_selection_time = 0.30


func disable() -> void:
	disabled = true
	active = true
	_cue.set_focused(false)


func interact(player: CharacterBody2D) -> void:
	if not is_available():
		return
	get_parent().commit_follow_up(self, player)


func set_focus(value: bool) -> void:
	_focused = value and is_available()
	_cue.set_focused(_focused)


func press_cue() -> void:
	_cue.press()


func pulse_recovery() -> void:
	if is_available():
		_cue.pulse_recovery()
