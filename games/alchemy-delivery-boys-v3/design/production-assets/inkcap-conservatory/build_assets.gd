extends SceneTree

const ROOT := "res://game/assets/production/inkcap-conservatory"
const INK := Color("12121f")
const INK_2 := Color("191a2c")
const SLATE := Color("243047")
const SLATE_DARK := Color("182237")
const SLATE_LIGHT := Color("4a5875")
const MULBERRY := Color("34243d")
const MULBERRY_DARK := Color("21182b")
const PARCHMENT := Color("fff3c4")
const COPPER := Color("d89b62")
const COPPER_SHADOW := Color("725a48")
const CYAN := Color("66d9e8")
const CORAL := Color("ef476f")
const LEAF := Color("9be564")
const VIOLET := Color("7f5af0")
const TEAL := Color("318c91")
const GOLD := Color("f3c969")
const SILVER := Color("d6d7e8")
const CLEAR := Color(0, 0, 0, 0)


func _initialize() -> void:
	for directory in [
		"environment", "interactables", "route-gates", "characters",
		"props", "effects", "interface"
	]:
		DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("%s/%s" % [ROOT, directory]))
	_build_frame()
	_build_workshop()
	_build_garden()
	_build_divider()
	_build_courier()
	_build_mira()
	_build_pedestal("warm", CORAL, Color("8e2748"))
	_build_pedestal("fizz", CYAN, Color("216777"))
	_build_cauldron()
	_build_gate("cooling", CYAN, Color("1d7188"), true)
	_build_gate("venting", COPPER, Color("704421"), false)
	_build_bottle()
	_build_plot("warm_cool", LEAF, CYAN)
	_build_plot("fizz_vent", COPPER, CORAL)
	_build_brew_effects()
	_build_route_effects()
	_build_reaction_effects()
	_build_selection_effects()
	_build_ui_motifs()
	print("INKCAP_ASSETS_BUILT")
	quit(0)


func _image(width: int, height: int, transparent := true) -> Image:
	var image := Image.create_empty(width, height, false, Image.FORMAT_RGBA8)
	image.fill(CLEAR if transparent else INK)
	return image


func _save(image: Image, relative_path: String) -> void:
	var error := image.save_png(ProjectSettings.globalize_path("%s/%s" % [ROOT, relative_path]))
	if error != OK:
		push_error("Could not save %s (%s)" % [relative_path, error])


func _rect(image: Image, x: int, y: int, width: int, height: int, color: Color) -> void:
	image.fill_rect(Rect2i(x, y, width, height), color)


func _pixel(image: Image, x: int, y: int, color: Color) -> void:
	if x >= 0 and y >= 0 and x < image.get_width() and y < image.get_height():
		image.set_pixel(x, y, color)


func _circle(image: Image, cx: int, cy: int, radius: int, color: Color) -> void:
	for y in range(-radius, radius + 1):
		for x in range(-radius, radius + 1):
			if x * x + y * y <= radius * radius:
				_pixel(image, cx + x, cy + y, color)


func _ring(image: Image, cx: int, cy: int, outer: int, inner: int, color: Color) -> void:
	for y in range(-outer, outer + 1):
		for x in range(-outer, outer + 1):
			var distance := x * x + y * y
			if distance <= outer * outer and distance >= inner * inner:
				_pixel(image, cx + x, cy + y, color)


func _line(image: Image, x0: int, y0: int, x1: int, y1: int, color: Color) -> void:
	var dx := absi(x1 - x0)
	var sx := 1 if x0 < x1 else -1
	var dy := -absi(y1 - y0)
	var sy := 1 if y0 < y1 else -1
	var error := dx + dy
	while true:
		_pixel(image, x0, y0, color)
		if x0 == x1 and y0 == y1:
			break
		var twice := 2 * error
		if twice >= dy:
			error += dy
			x0 += sx
		if twice <= dx:
			error += dx
			y0 += sy


func _build_frame() -> void:
	var image := _image(480, 212, false)
	_rect(image, 0, 0, 480, 212, Color("0d101b"))
	_rect(image, 2, 0, 476, 4, COPPER_SHADOW)
	_rect(image, 4, 4, 472, 3, SLATE_DARK)
	for x in range(18, 470, 24):
		_line(image, x, 5, x + 10, 18, Color("273754"))
		_line(image, x + 10, 18, x + 22, 5, Color("31435f"))
		if x % 48 == 18:
			_pixel(image, x + 10, 11, CYAN.darkened(0.35))
	_rect(image, 0, 204, 480, 8, INK)
	_rect(image, 0, 204, 480, 1, COPPER_SHADOW)
	_save(image, "environment/conservatory-frame.png")


func _build_workshop() -> void:
	var image := _image(600, 212, true)
	for frame in range(2):
		var ox := frame * 300
		_rect(image, ox, 0, 300, 212, SLATE_DARK)
		# Hand-laid flagstones, deliberately quieter through the navigable center.
		for y in range(28, 205, 16):
			var stagger := 8 if int(y / 16) % 2 == 0 else 0
			for x in range(-stagger, 300, 24):
				var shade := SLATE if (x + y) % 48 == 0 else Color("202b43")
				_rect(image, ox + x + 1, y + 1, 22, 14, shade)
				_line(image, ox + x + 2, y + 2, ox + x + 19, y + 2, Color("33425e"))
				if (x * 3 + y) % 64 == 0:
					_line(image, ox + x + 10, y + 5, ox + x + 14, y + 8, Color("131b2d"))
		# Brass/glass shelving along the top and left boundaries only.
		_rect(image, ox + 4, 4, 292, 22, Color("141b2d"))
		_rect(image, ox + 6, 23, 288, 2, COPPER_SHADOW)
		for x in range(12, 290, 28):
			_rect(image, ox + x, 8, 13, 12, Color("1e2840"))
			_rect(image, ox + x + 1, 9, 11, 1, COPPER_SHADOW)
			_circle(image, ox + x + 4, 16, 3, VIOLET.darkened(0.25))
			_pixel(image, ox + x + 5, 14, CYAN if int(x / 28) % 2 == 0 else CORAL)
		_rect(image, ox + 1, 31, 24, 160, Color("151b2c"))
		for y in range(38, 187, 28):
			_rect(image, ox + 4, y, 16, 20, Color("262039"))
			_rect(image, ox + 6, y + 3, 12, 2, COPPER_SHADOW)
			_circle(image, ox + 9, y + 13, 3, VIOLET.darkened(0.15))
			_rect(image, ox + 14, y + 9, 3, 8, COPPER)
		# Botanical clutter stays below the ingredient line and outside anchors.
		_rect(image, ox + 1, 191, 112, 17, Color("141b29"))
		for x in range(8, 108, 16):
			_line(image, ox + x, 205, ox + x + ((x % 3) - 1) * 3, 195, LEAF.darkened(0.45))
			_circle(image, ox + x - 2, 196, 2, VIOLET.darkened(0.2))
		# Frame two changes only authored light pixels; geometry is identical.
		if frame == 1:
			for point in [Vector2i(44, 13), Vector2i(156, 16), Vector2i(263, 12), Vector2i(18, 104)]:
				_circle(image, ox + point.x, point.y, 1, Color(CYAN, 0.85))
		else:
			for point in [Vector2i(45, 13), Vector2i(155, 16), Vector2i(264, 12), Vector2i(18, 105)]:
				_pixel(image, ox + point.x, point.y, Color(VIOLET, 0.7))
	_save(image, "environment/workshop-environment.png")


func _build_garden() -> void:
	var image := _image(260, 212, true)
	for frame in range(2):
		var ox := frame * 130
		_rect(image, ox, 0, 130, 212, MULBERRY_DARK)
		# Mulberry beds frame a clean crooked path to Mira and the plots.
		for y in range(4, 208, 8):
			for x in range(3, 127, 8):
				var noise := (x * 17 + y * 11) % 7
				if noise < 2:
					_pixel(image, ox + x, y, Color("52335b"))
		_rect(image, ox + 46, 0, 40, 168, Color("3b3047"))
		for y in range(8, 164, 14):
			_rect(image, ox + 48 + (y % 3), y, 35, 11, Color("41374e"))
			_line(image, ox + 49, y + 1, ox + 81, y + 1, Color("54445f"))
		# Moon crystal and inkcap clusters are edge life, never actors.
		_line(image, ox + 81, 44, ox + 92, 21, VIOLET.darkened(0.35))
		_line(image, ox + 92, 21, ox + 103, 44, VIOLET)
		_line(image, ox + 103, 44, ox + 91, 52, VIOLET.darkened(0.15))
		_line(image, ox + 91, 52, ox + 81, 44, VIOLET.darkened(0.45))
		_rect(image, ox + 89, 31, 5, 15, Color("9a7cff"))
		for point in [Vector2i(12, 34), Vector2i(20, 94), Vector2i(110, 73), Vector2i(18, 172), Vector2i(115, 188)]:
			_rect(image, ox + point.x, point.y + 3, 2, 5, Color("b9d7d4"))
			_circle(image, ox + point.x + 1, point.y + 2, 4, VIOLET.darkened(0.18))
			_pixel(image, ox + point.x + 2, point.y, CORAL.darkened(0.1))
		for point in [Vector2i(8, 66), Vector2i(116, 112), Vector2i(26, 142), Vector2i(104, 154)]:
			_line(image, ox + point.x, point.y + 6, ox + point.x + 2, point.y, LEAF.darkened(0.3))
			_pixel(image, ox + point.x + 3, point.y + 1, CYAN.darkened(0.15))
		if frame == 1:
			for point in [Vector2i(14, 35), Vector2i(112, 74), Vector2i(20, 173), Vector2i(102, 155)]:
				_circle(image, ox + point.x, point.y, 1, Color(CYAN, 0.9))
	_save(image, "environment/garden-environment.png")


func _build_divider() -> void:
	var image := _image(12, 212, true)
	for span in [Vector2i(0, 51), Vector2i(91, 22), Vector2i(153, 59)]:
		for y in range(span.x, span.x + span.y, 6):
			var stagger := 3 if int(y / 6) % 2 else 0
			for x in range(-stagger, 12, 7):
				_rect(image, x, y, 6, 5, Color("3d2f3e"))
				_line(image, x, y, x + 5, y, COPPER_SHADOW.darkened(0.25))
	_rect(image, 0, 49, 12, 2, INK)
	_rect(image, 0, 91, 12, 2, INK)
	_rect(image, 0, 111, 12, 2, INK)
	_rect(image, 0, 153, 12, 2, INK)
	_save(image, "environment/divider-environment.png")


func _build_courier() -> void:
	var image := _image(20 * 16, 28, true)
	for frame in range(16):
		var ox := frame * 20
		var step := 1 if frame % 2 == 0 else -1
		var lift := 1 if frame in [5, 7, 9, 13] else 0
		# Shadow is intentionally part of the actor sheet and never baked into floor art.
		_rect(image, ox + 4, 24, 12, 2, Color(0.04, 0.04, 0.08, 0.58))
		_rect(image, ox + 7 + step, 21 - lift, 3, 5, INK)
		_rect(image, ox + 11 - step, 21 + lift, 3, 5, INK)
		_rect(image, ox + 5, 11, 10, 12, INK)
		_rect(image, ox + 6, 12, 8, 10, TEAL)
		_rect(image, ox + 7, 13, 2, 8, Color("54b8ad"))
		_rect(image, ox + 14, 14, 3, 7, Color("294f77"))
		_rect(image, ox + 6, 5, 8, 8, INK)
		_rect(image, ox + 7, 6, 6, 6, Color("d89b62"))
		_pixel(image, ox + 9, 8, INK)
		_pixel(image, ox + 12, 8, INK)
		_rect(image, ox + 4, 3, 12, 4, INK)
		_rect(image, ox + 5, 2, 10, 4, GOLD)
		_rect(image, ox + 7, 1, 6, 2, Color("ffe79b"))
		if frame >= 8 and frame <= 11:
			# Up-facing frames preserve the cap while reducing facial detail.
			_rect(image, ox + 7, 7, 6, 5, COPPER_SHADOW)
		if frame in [10, 11]:
			# Brew anticipation and follow-through lean toward the cauldron.
			_rect(image, ox + 15, 13, 3 + (frame - 10), 2, PARCHMENT)
		if frame == 14:
			_rect(image, ox + 15, 9, 4, 2, PARCHMENT)
		if frame == 15:
			_rect(image, ox + 3, 11, 3, 2, LEAF)
	_save(image, "characters/courier-actor.png")


func _build_mira() -> void:
	var image := _image(24 * 6, 32, true)
	for frame in range(6):
		var ox := frame * 24
		var bounce := -2 if frame == 3 else (1 if frame == 2 else 0)
		_rect(image, ox + 5, 29, 14, 2, Color(0.04, 0.04, 0.08, 0.58))
		_rect(image, ox + 6, 14 + bounce, 12, 15, INK)
		_rect(image, ox + 7, 15 + bounce, 10, 13, VIOLET.darkened(0.15 if frame != 4 else 0.38))
		_rect(image, ox + 8, 6 + bounce, 8, 9, INK)
		_rect(image, ox + 9, 7 + bounce, 6, 7, COPPER)
		_rect(image, ox + 6, 5 + bounce, 3, 13, SILVER)
		_rect(image, ox + 15, 5 + bounce, 3, 13, SILVER)
		_pixel(image, ox + 10, 9 + bounce, INK)
		_pixel(image, ox + 14, 9 + bounce, INK)
		var mouth := LEAF if frame in [3, 5] else (CORAL if frame == 4 else COPPER_SHADOW)
		_rect(image, ox + 11, 12 + bounce, 3, 1, mouth)
		if frame == 1:
			_rect(image, ox + 4, 13, 3, 2, PARCHMENT)
		if frame == 2:
			_rect(image, ox + 4, 11 + bounce, 4, 2, PARCHMENT)
	_save(image, "characters/mira-actor.png")


func _build_pedestal(id: String, accent: Color, shadow: Color) -> void:
	var image := _image(24 * 5, 32, true)
	for frame in range(5):
		var ox := frame * 24
		var rise := 1 if frame == 1 else 0
		if frame == 1:
			_ring(image, ox + 12, 14, 11, 9, Color(accent, 0.68))
		if frame == 2:
			_ring(image, ox + 12, 14, 11, 8, Color(LEAF, 0.75))
		_rect(image, ox + 5, 21, 14, 6, INK)
		_rect(image, ox + 6, 20, 12, 6, COPPER_SHADOW)
		_rect(image, ox + 8, 17 - rise, 8, 4, shadow)
		_circle(image, ox + 12, 12 - rise, 7, INK)
		_circle(image, ox + 12, 11 - rise, 6, accent.darkened(0.25 if frame == 4 else 0.0))
		_rect(image, ox + 9, 8 - rise, 5, 2, accent.lightened(0.28))
		if id == "fizz":
			_pixel(image, ox + 10, 11 - rise, PARCHMENT)
			_pixel(image, ox + 14, 9 - rise, PARCHMENT)
		else:
			_line(image, ox + 9, 14 - rise, ox + 15, 8 - rise, CORAL.lightened(0.22))
	_save(image, "interactables/%s-ingredient.png" % id)


func _build_cauldron() -> void:
	var image := _image(48 * 6, 48, true)
	for frame in range(6):
		var ox := frame * 48
		if frame in [1, 2, 3]:
			_ring(image, ox + 24, 26, 22, 20, Color(VIOLET, 0.18 + frame * 0.06))
		_rect(image, ox + 9, 22, 30, 17, INK)
		_rect(image, ox + 11, 24, 26, 14, Color("382d4c"))
		_rect(image, ox + 7, 19, 34, 5, INK)
		_rect(image, ox + 9, 19, 30, 3, COPPER)
		_rect(image, ox + 12, 21, 24, 3, Color("21162d"))
		_rect(image, ox + 13, 22, 22, 2, VIOLET.darkened(0.2))
		_rect(image, ox + 12, 38, 5, 5, COPPER_SHADOW)
		_rect(image, ox + 31, 38, 5, 5, COPPER_SHADOW)
		if frame >= 2 and frame <= 4:
			_circle(image, ox + 18, 15 - (frame % 2) * 3, 3, CYAN)
			_circle(image, ox + 29, 12 + (frame % 2) * 2, 2, CORAL)
			_pixel(image, ox + 17, 14 - (frame % 2) * 3, PARCHMENT)
		if frame == 5:
			_rect(image, ox + 15, 21, 18, 2, VIOLET.darkened(0.5))
	_save(image, "interactables/brew-station.png")


func _build_gate(id: String, accent: Color, shadow: Color, crystal: bool) -> void:
	var image := _image(22 * 4, 40, true)
	for frame in range(4):
		var ox := frame * 22
		_rect(image, ox, 0, 22, 40, INK)
		_rect(image, ox + 2, 1, 18, 38, shadow)
		_rect(image, ox + 4, 2, 14, 36, Color("161d2c"))
		for y in range(6, 36, 8):
			if crystal:
				_rect(image, ox + 5, y, 12, 4, accent.darkened(0.35 if frame == 0 else 0.08))
				_rect(image, ox + 7 + (frame % 2), y + 1, 7, 1, accent.lightened(0.25))
			else:
				var opening := frame in [1, 2]
				var offset := 3 if opening else 0
				_line(image, ox + 5 - offset, y, ox + 17 + offset, y, accent)
				_line(image, ox + 6 - offset, y + 1, ox + 16 + offset, y + 1, COPPER_SHADOW)
		if frame == 2:
			_rect(image, ox + 1, 0, 2, 40, accent)
			_rect(image, ox + 19, 0, 2, 40, accent)
		# Preserve clean transparent corner pixels around every state-swapped gate frame.
		for point in [Vector2i(0, 0), Vector2i(1, 0), Vector2i(20, 0), Vector2i(21, 0), Vector2i(0, 39), Vector2i(1, 39), Vector2i(20, 39), Vector2i(21, 39)]:
			_pixel(image, ox + point.x, point.y, CLEAR)
	_save(image, "route-gates/%s-gate.png" % id)


func _build_bottle() -> void:
	var image := _image(8 * 5, 12, true)
	var liquids := [CORAL, LEAF, CYAN, PARCHMENT, CLEAR]
	for frame in range(5):
		var ox := frame * 8
		if frame == 4:
			continue
		_rect(image, ox + 3, 0, 3, 2, COPPER)
		_rect(image, ox + 2, 2, 5, 2, INK)
		_rect(image, ox + 1, 4, 7, 7, INK)
		_rect(image, ox + 2, 5, 5, 5, liquids[frame])
		_pixel(image, ox + 3, 5, PARCHMENT)
		# Non-color route marks: round vent dot, angular cool notch, handoff stripe.
		if frame == 0:
			_line(image, ox + 2, 9, ox + 6, 6, CYAN)
		elif frame == 1:
			_circle(image, ox + 5, 8, 1, PARCHMENT)
		elif frame == 2:
			_line(image, ox + 2, 6, ox + 6, 9, PARCHMENT)
		elif frame == 3:
			_rect(image, ox + 2, 7, 5, 1, CORAL)
	_save(image, "props/carried-bottle.png")


func _build_plot(id: String, accent: Color, secondary: Color) -> void:
	var image := _image(32 * 6, 24, true)
	for frame in range(6):
		var ox := frame * 32
		var muted := frame == 4
		var base := Color("49304d") if not muted else Color("282130")
		_rect(image, ox + 3, 10, 26, 9, INK)
		_rect(image, ox + 4, 9, 24, 9, base)
		_rect(image, ox + 6, 11, 20, 4, Color("241a2b"))
		if frame == 0:
			_rect(image, ox + 14, 11, 4, 3, COPPER_SHADOW.darkened(0.3))
		else:
			var mark := accent.darkened(0.55) if muted else accent
			_rect(image, ox + 14, 7, 4, 10, mark)
			_rect(image, ox + 11, 10, 10, 4, mark)
			_pixel(image, ox + 15, 8, secondary)
		if frame in [1, 2, 3, 5]:
			_ring(image, ox + 16, 12, 13 if frame == 3 else 11, 10 if frame == 3 else 9, Color(accent, 0.72))
	_save(image, "interactables/follow-up-%s.png" % id)


func _build_brew_effects() -> void:
	var image := _image(36 * 5, 35, true)
	for frame in range(5):
		var ox := frame * 36
		var lift := frame * 3
		if frame < 4:
			_circle(image, ox + 12, 28 - lift, maxi(1, 3 - int(frame / 2)), CYAN)
			_circle(image, ox + 25, 24 - lift, maxi(1, 2 - int(frame / 3)), CORAL)
			_pixel(image, ox + 11, 27 - lift, PARCHMENT)
		if frame in [1, 2, 3]:
			_line(image, ox + 5, 31, ox + 30, 31, Color(COPPER, 0.8))
	_save(image, "effects/brew-effects.png")


func _build_route_effects() -> void:
	var image := _image(66 * 5, 45, true)
	for frame in range(5):
		var ox := frame * 66
		if frame < 4:
			var travel := 8 + frame * 13
			_circle(image, ox + travel, 24, max(1, 5 - frame), Color(COPPER, 0.8 - frame * 0.12))
			_circle(image, ox + travel + 7, 17 + frame, 2, Color(CORAL, 0.8))
			_pixel(image, ox + travel + 12, 27 - frame, PARCHMENT)
		if frame == 4:
			_circle(image, ox + 58, 22, 3, LEAF)
			_pixel(image, ox + 58, 20, PARCHMENT)
	_save(image, "effects/route-effects.png")


func _build_reaction_effects() -> void:
	var image := _image(43 * 5, 34, true)
	for frame in range(5):
		var ox := frame * 43
		if frame in [1, 2, 3]:
			var spread := frame * 4
			_circle(image, ox + 21 - spread, 19 - frame * 3, 2, CYAN)
			_circle(image, ox + 21 + spread, 19 - frame * 2, 2, CORAL)
			_pixel(image, ox + 21, 8 + frame, LEAF)
	_save(image, "effects/reaction-effects.png")


func _build_selection_effects() -> void:
	var image := _image(32 * 5, 32, true)
	for frame in range(5):
		var ox := frame * 32
		if frame in [1, 2, 3]:
			_ring(image, ox + 16, 18, 9 + frame * 2, 8 + frame * 2, Color(LEAF, 0.9 - frame * 0.12))
			_pixel(image, ox + 16, 12 - frame * 2, PARCHMENT)
		if frame == 4:
			_ring(image, ox + 16, 18, 13, 11, Color(COPPER_SHADOW, 0.8))
	_save(image, "effects/selection-effects.png")


func _build_ui_motifs() -> void:
	var ledger := _image(16, 16, true)
	_rect(ledger, 0, 0, 16, 16, Color("10101c"))
	_rect(ledger, 0, 0, 16, 1, COPPER_SHADOW)
	_rect(ledger, 0, 15, 16, 1, SLATE_LIGHT.darkened(0.35))
	_rect(ledger, 0, 0, 1, 16, COPPER_SHADOW.darkened(0.2))
	_rect(ledger, 15, 0, 1, 16, COPPER_SHADOW.darkened(0.2))
	_pixel(ledger, 2, 2, COPPER)
	_pixel(ledger, 13, 2, CYAN.darkened(0.2))
	_save(ledger, "interface/ledger-panel.png")

	var context := _image(16, 16, true)
	_rect(context, 0, 0, 16, 16, Color("0e1020"))
	_rect(context, 0, 0, 16, 1, SLATE_LIGHT.darkened(0.25))
	_rect(context, 0, 15, 16, 1, INK)
	_pixel(context, 2, 2, VIOLET)
	_pixel(context, 13, 2, COPPER)
	_save(context, "interface/context-panel.png")

	var cue := _image(16, 12, true)
	_rect(cue, 0, 2, 16, 8, Color("111321"))
	_rect(cue, 1, 1, 14, 1, COPPER_SHADOW)
	_rect(cue, 1, 10, 14, 1, COPPER_SHADOW)
	_rect(cue, 0, 3, 1, 6, COPPER_SHADOW)
	_rect(cue, 15, 3, 1, 6, COPPER_SHADOW)
	_pixel(cue, 2, 3, CYAN.darkened(0.25))
	_save(cue, "interface/world-cue-panel.png")
