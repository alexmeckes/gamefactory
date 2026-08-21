extends Node2D

const PANEL := preload("res://game/assets/production/inkcap-conservatory/interface/world-cue-panel.png")
const FONT := preload("res://game/assets/production/inkcap-conservatory/interface/fonts/DejaVuSans-Bold.ttf")
const PARCHMENT := Color("fff3c4")
const CYAN := Color("66d9e8")
const LEAF := Color("9be564")

var label_text: String = "INTERACT [E]"
var cue_offset: Vector2 = Vector2(-26, -40)
var accent: Color = CYAN
var _focused: bool = false
var _press_time: float = 0.0
var _recovery_time: float = 0.0
var _base_position: Vector2


func configure(text: String, offset: Vector2, cue_accent: Color = CYAN) -> void:
	label_text = text
	cue_offset = offset
	accent = cue_accent


func _ready() -> void:
	texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_base_position = cue_offset.round()
	position = _base_position
	var width := maxi(38, label_text.length() * 5 + 12)
	var panel := NinePatchRect.new()
	panel.texture = PANEL
	panel.position = Vector2.ZERO
	panel.size = Vector2(width, 13)
	panel.patch_margin_left = 4
	panel.patch_margin_top = 4
	panel.patch_margin_right = 4
	panel.patch_margin_bottom = 4
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(panel)
	var accent_line := ColorRect.new()
	accent_line.position = Vector2(3, 2)
	accent_line.size = Vector2(2, 9)
	accent_line.color = accent
	accent_line.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_child(accent_line)
	var label := Label.new()
	label.position = Vector2(8, 0)
	label.size = Vector2(width - 10, 13)
	label.text = label_text
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.add_theme_font_override("font", FONT)
	label.add_theme_font_size_override("font_size", 7)
	label.add_theme_color_override("font_color", PARCHMENT)
	label.add_theme_color_override("font_shadow_color", Color("12121f"))
	label.add_theme_constant_override("shadow_offset_x", 1)
	label.add_theme_constant_override("shadow_offset_y", 1)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_child(label)
	visible = false


func set_focused(value: bool) -> void:
	_focused = value
	visible = _focused or _recovery_time > 0.0
	modulate = Color.WHITE if _focused else Color(LEAF, 0.92)


func press() -> void:
	_press_time = 0.12
	visible = true


func pulse_recovery() -> void:
	_recovery_time = 0.9
	visible = true


func _process(delta: float) -> void:
	_press_time = maxf(0.0, _press_time - delta)
	_recovery_time = maxf(0.0, _recovery_time - delta)
	position = _base_position + (Vector2.DOWN if _press_time > 0.0 else Vector2.ZERO)
	if _recovery_time > 0.0 and not _focused:
		var glow := 0.72 + sin(_recovery_time * 22.0) * 0.18
		modulate = Color(LEAF, glow)
	visible = _focused or _press_time > 0.0 or _recovery_time > 0.0

