extends CanvasLayer

const LEDGER_PANEL := preload("res://game/assets/production/inkcap-conservatory/interface/ledger-panel.png")
const CONTEXT_PANEL := preload("res://game/assets/production/inkcap-conservatory/interface/context-panel.png")
const BODY_FONT := preload("res://game/assets/production/inkcap-conservatory/interface/fonts/DejaVuSans.ttf")
const BOLD_FONT := preload("res://game/assets/production/inkcap-conservatory/interface/fonts/DejaVuSans-Bold.ttf")
const INK := Color("12121f")
const PARCHMENT := Color("fff3c4")
const CYAN := Color("66d9e8")
const CORAL := Color("ef476f")
const LEAF := Color("9be564")
const COPPER := Color("d89b62")

var _top: NinePatchRect
var _bottom: NinePatchRect
var _need: Label
var _middle: Label
var _right: Label
var _feedback: Label


func _ready() -> void:
	_top = _panel(LEDGER_PANEL, Vector2.ZERO, Vector2(480, 32), 5)
	add_child(_top)
	_need = _label(_top, Vector2(8, 3), Vector2(145, 25), BOLD_FONT, 8, COPPER)
	_middle = _label(_top, Vector2(160, 3), Vector2(154, 25), BOLD_FONT, 8, CYAN)
	_right = _label(_top, Vector2(322, 3), Vector2(150, 25), BOLD_FONT, 8, PARCHMENT)
	_add_rule(_top, 154)
	_add_rule(_top, 316)
	_bottom = _panel(CONTEXT_PANEL, Vector2(0, 244), Vector2(480, 26), 5)
	add_child(_bottom)
	_feedback = _label(_bottom, Vector2(8, 1), Vector2(464, 23), BODY_FONT, 8, PARCHMENT)
	set_status("MIRA · BALANCE", "PLAN · FIZZ", "BOTTLE · NONE", "normal")
	show_feedback("CHOOSE WARM OR FIZZ, THEN BREW  ·  WASD MOVE  ·  E INTERACT", "controls")


func _panel(texture: Texture2D, panel_position: Vector2, panel_size: Vector2, margin: int) -> NinePatchRect:
	var panel := NinePatchRect.new()
	panel.texture = texture
	panel.position = panel_position
	panel.size = panel_size
	panel.patch_margin_left = margin
	panel.patch_margin_top = margin
	panel.patch_margin_right = margin
	panel.patch_margin_bottom = margin
	panel.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return panel


func _label(parent: Control, label_position: Vector2, label_size: Vector2, font: Font, font_size: int, color: Color) -> Label:
	var label := Label.new()
	label.position = label_position
	label.size = label_size
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.add_theme_font_override("font", font)
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	label.add_theme_color_override("font_shadow_color", INK)
	label.add_theme_constant_override("shadow_offset_x", 1)
	label.add_theme_constant_override("shadow_offset_y", 1)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(label)
	return label


func _add_rule(parent: Control, x: int) -> void:
	var rule := ColorRect.new()
	rule.position = Vector2(x, 7)
	rule.size = Vector2(1, 18)
	rule.color = Color("4a5875")
	rule.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(rule)


func set_status(need_text: String, middle_text: String, right_text: String, state: String) -> void:
	_need.text = need_text.to_upper()
	_middle.text = middle_text.to_upper()
	_right.text = right_text.to_upper()
	_middle.add_theme_color_override("font_color", LEAF if state == "resolved" else CYAN)
	_right.add_theme_color_override("font_color", LEAF if state == "resolved" else PARCHMENT)


func show_feedback(message: String, state: String = "feedback") -> void:
	_feedback.text = message.to_upper()
	var color := PARCHMENT
	if state == "recovery":
		color = CORAL
	elif state == "resolved":
		color = LEAF
	elif state == "feedback":
		color = CYAN
	_feedback.add_theme_color_override("font_color", color)
	_bottom.modulate = Color(1.06, 1.06, 1.06, 1.0) if state in ["feedback", "resolved"] else Color.WHITE
