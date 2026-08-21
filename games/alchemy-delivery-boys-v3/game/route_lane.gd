extends Area2D

const COOL_TEXTURE := preload("res://game/assets/production/inkcap-conservatory/route-gates/cooling-gate.png")
const VENT_TEXTURE := preload("res://game/assets/production/inkcap-conservatory/route-gates/venting-gate.png")
const DISPLAY_FONT := preload("res://game/assets/production/inkcap-conservatory/interface/fonts/DejaVuSans-Bold.ttf")

@export_enum("cooling", "venting") var effect_id: String = "cooling"

var activated: bool = false
var _activation_time: float = 0.0
var _recovery_time: float = 0.0

@onready var visual: Sprite2D = $Visual
@onready var effect: Sprite2D = $Effect


func _ready() -> void:
	body_entered.connect(_on_body_entered)
	visual.texture = COOL_TEXTURE if effect_id == "cooling" else VENT_TEXTURE
	visual.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	effect.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	var label := Label.new()
	label.position = Vector2(-18, -34)
	label.size = Vector2(36, 11)
	label.text = "COOL" if effect_id == "cooling" else "VENT"
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.add_theme_font_override("font", DISPLAY_FONT)
	label.add_theme_font_size_override("font_size", 7)
	label.add_theme_color_override("font_color", Color("66d9e8") if effect_id == "cooling" else Color("d89b62"))
	label.add_theme_color_override("font_shadow_color", Color("12121f"))
	label.add_theme_constant_override("shadow_offset_x", 1)
	label.add_theme_constant_override("shadow_offset_y", 1)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(label)


func _process(delta: float) -> void:
	_activation_time = maxf(0.0, _activation_time - delta)
	_recovery_time = maxf(0.0, _recovery_time - delta)
	if _activation_time > 0.0:
		var progress := 1.0 - _activation_time / 0.36
		visual.frame = 2 if progress < 0.72 else 3
		effect.visible = true
		effect.frame = clampi(int(floor(progress * 5.0)), 0, 4)
	else:
		visual.frame = 3 if activated else (1 if _recovery_time > 0.0 else 0)
		effect.visible = false
	if _recovery_time > 0.0:
		visual.modulate.a = 0.78 + sin(_recovery_time * 22.0) * 0.18
	else:
		visual.modulate = Color.WHITE


func _on_body_entered(body: Node2D) -> void:
	if not body.has_method("apply_route"):
		return
	if body.apply_route(effect_id):
		activated = true
		_activation_time = 0.36
		get_parent().on_route_applied(body, effect_id)


func pulse_recovery() -> void:
	_recovery_time = 0.9

