extends Sprite2D

@export var frame_period: float = 2.4
@export var phase_seconds: float = 0.0

var _time: float = 0.0


func _ready() -> void:
	_time = phase_seconds
	texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST


func _process(delta: float) -> void:
	_time += delta
	frame = int(floor(_time / frame_period)) % maxi(1, hframes)

