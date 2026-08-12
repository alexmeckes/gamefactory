extends Node2D

const VIEW := Vector2(1152, 720)
const N := 34
const SEGMENTS := [24.0, 26.0, 38.0, 40.0]
const SLATE := Color("111a1d")
const BONE := Color("f2e7d5")
const CHALK := Color("91a3a8")
const FLAX := Color("e8bd72")
const LIT := Color("ffe0a0")
const BRASS := Color("c79a49")
const CORAL := Color("dd6b57")

var levels := [
	{"name":"TAKE UP SLACK","mark":"I / IV","lesson":"PULL  ·  SET THE END IN THE BRASS CLEAT","start":Vector2(170,390),"end":Vector2(665,520),"cleat":Vector2(925,390),"eyes":[],"cap":Vector2.ZERO,"route":false,"wrap":false},
	{"name":"THROUGH THE EYE","mark":"II / IV","lesson":"THREAD  ·  THEN MAKE THE LINE FAST","start":Vector2(150,470),"end":Vector2(500,545),"cleat":Vector2(945,315),"eyes":[Vector2(620,390)],"cap":Vector2.ZERO,"route":true,"wrap":false},
	{"name":"MAKE FAST","mark":"III / IV","lesson":"LOOP CLOCKWISE  ·  DOCK UNDER TENSION","start":Vector2(150,420),"end":Vector2(485,520),"cleat":Vector2(950,460),"eyes":[],"cap":Vector2(665,390),"route":false,"wrap":true},
	{"name":"THE BELL HOIST","mark":"IV / IV","lesson":"THREAD  ·  LOOP  ·  PULL THE WORKSHOP AWAKE","start":Vector2(125,505),"end":Vector2(420,570),"cleat":Vector2(1020,520),"eyes":[Vector2(430,350),Vector2(690,285)],"cap":Vector2(830,420),"route":true,"wrap":true}
]
var points: Array[Vector2] = []
var started := false
var level := 0
var grabbed := -1
var hover := -1
var pinned: Dictionary = {}
var docked := false
var solved := false
var hold := 0.0
var route_signature: Array[int] = []
var thread_sequence: Array[int] = []
var route_ok := false
var wrap_ok := false
var taut_ok := false
var winding := 0.0
var topology_winding := 0.0
var tautness := 0.0
var load_height := 0.0
var pulse := 0.0
var fibers: Array[Dictionary] = []
var factory_mode := false
var factory_ticks := 0
var factory_drag_samples := 0
var solved_levels: Dictionary = {}
var verbs: Dictionary = {}
var transitions := 0
var goals := 0
var resets := 0
var progressions := 0
var replays := 0
var invalid_cases := 0
var max_load := 0.0
var finite_state := true
var prior := [false,false,false,false]
var visited_levels: Dictionary = {}
var near_misses: Dictionary = {}
var audio_players: Array[AudioStreamPlayer] = []
var audio_streams: Dictionary = {}
var audio_cursor := 0
var tension_cued := false
var reject_pulse := 0.0
var reject_position := Vector2.ZERO
var bell_pulse := 0.0
var factory_path: Array[Vector2] = []

func _ready() -> void:
	_build_audio()
	queue_redraw()

func _process(delta: float) -> void:
	if started:
		if grabbed < 0 and not docked: _relax(3)
		_evaluate(delta)
		pulse = maxf(0.0, pulse - delta)
		reject_pulse = maxf(0.0, reject_pulse - delta * 2.8)
		bell_pulse = maxf(0.0, bell_pulse - delta * 1.4)
		for i in range(fibers.size()-1,-1,-1):
			fibers[i].p += fibers[i].v * delta
			fibers[i].v *= 0.94
			fibers[i].life -= delta
			if fibers[i].life <= 0: fibers.remove_at(i)
	queue_redraw()

func _reset(count := true) -> void:
	if count:
		resets += 1
		_play_cue("reset")
	points.clear()
	pinned.clear()
	var d: Dictionary = levels[level]
	for i in range(N):
		var t := float(i)/float(N-1)
		var p: Vector2 = d.start.lerp(d.end,t)
		p.y += sin(t*TAU*1.2)*45.0 + sin(t*PI)*78.0
		points.append(p)
	grabbed=-1; hover=-1; docked=false; solved=false; hold=0; pulse=0; load_height=0; reject_pulse=0; bell_pulse=0
	route_signature.clear(); thread_sequence.clear(); winding=0; topology_winding=0; tautness=0; prior=[false,false,false,false]; tension_cued=false

func _unhandled_input(e: InputEvent) -> void:
	if factory_mode: return
	if e is InputEventKey and e.pressed:
		if e.keycode==KEY_R and started: _reset()
		elif e.keycode==KEY_ESCAPE: started=false
	if e is InputEventMouseMotion:
		hover=_nearest(e.position,34)
		if grabbed>=0 and not docked: _drag_to(e.position)
	if e is InputEventMouseButton and e.button_index==MOUSE_BUTTON_LEFT:
		if e.pressed: _press(e.position)
		else: _release(e.position)
	if e is InputEventMouseButton and e.button_index==MOUSE_BUTTON_RIGHT and e.pressed:
		_toggle_pin(e.position)

func _press(p: Vector2) -> void:
	if not started:
		if Rect2(456,548,240,58).has_point(p): started=true; level=0; _reset(false)
		return
	if Rect2(974,35,142,48).has_point(p): _reset(); return
	if solved and Rect2(476,383,200,38).has_point(p):
		if level==3: level=0; replays+=1
		else: level+=1; progressions+=1
		_reset(false); return
	if docked and p.distance_to(levels[level].cleat)<48:
		docked=false; grabbed=N-1; verbs.undock=true; _play_cue("release"); return
	grabbed=_nearest(p,40)
	if grabbed>=0:
		if pinned.has(grabbed): grabbed=-1
		else: _play_cue("grab")

func _release(p: Vector2) -> void:
	if grabbed>=N-3 and p.distance_to(levels[level].cleat)<58:
		docked=true; points[N-1]=levels[level].cleat; verbs.dock=true; _burst(points[N-1],7); _play_cue("dock")
	elif grabbed>=N-3:
		reject_position=points[grabbed]; reject_pulse=1.0; _play_cue("reject")
	grabbed=-1

func _drag_to(position: Vector2) -> void:
	if grabbed < 0 or docked or pinned.has(grabbed): return
	var target:=Vector2(clampf(position.x,45,1107),clampf(position.y,150,680))
	_track_topology(points[grabbed],target)
	points[grabbed]=target
	_relax(12)
	verbs.pull=true

func _track_topology(previous:Vector2,current:Vector2)->void:
	# In two dimensions, over/under state must be explicit. Crossing an eye's
	# aperture with the working end records a durable contact in order; it is
	# the interaction analogue of passing a real rope end through a ring.
	var eyes:Array=levels[level].eyes
	for eye_index in range(eyes.size()):
		if _seg_dist(eyes[eye_index],previous,current)<22.0:
			if thread_sequence.is_empty() or thread_sequence[-1]!=eye_index:
				thread_sequence.append(eye_index)
				verbs.thread=true
				_play_cue("release")
	var cap:Vector2=levels[level].cap
	if cap!=Vector2.ZERO:
		var a:=previous-cap; var b:=current-cap
		if a.length()>=54.0 and a.length()<=132.0 and b.length()>=54.0 and b.length()<=132.0:
			topology_winding+=wrapf(b.angle()-a.angle(),-PI,PI)
			if topology_winding>=TAU*.88: verbs.loop=true

func _toggle_pin(position: Vector2) -> void:
	if not started or solved: return
	var index:=_nearest(position,38)
	if index<=0 or index>=N-1: return
	if pinned.has(index):
		pinned.erase(index)
		_play_cue("release")
	else:
		pinned[index]=points[index]
		verbs.pin=true
		_play_cue("pin")
		_burst(points[index],5)

func _nearest(p: Vector2, radius: float) -> int:
	var best=-1; var dist=radius
	for i in range(points.size()):
		var d=points[i].distance_to(p)
		if d<dist: best=i; dist=d
	return best

func _relax(iterations: int) -> void:
	if points.size()<2: return
	for k in range(iterations):
		points[0]=levels[level].start
		if docked: points[N-1]=levels[level].cleat
		for i in range(N-1):
			var delta=points[i+1]-points[i]; var distance=maxf(delta.length(),.001)
			# Rope resists stretching but does not behave like a row of rigid rods.
			# Compressed samples remain slack instead of exploding into sawteeth.
			var excess=maxf(distance-_segment_length(),0.0)
			var correction=delta*(excess/distance)*.52
			if i!=0 and i!=grabbed and not pinned.has(i): points[i]+=correction
			if i+1!=grabbed and not pinned.has(i+1) and not (docked and i+1==N-1): points[i+1]-=correction
		_resolve_fixture_collisions()
		for index in pinned: points[index]=pinned[index]

func _segment_length()->float:
	return SEGMENTS[level]

func _resolve_fixture_collisions()->void:
	var cap:Vector2=levels[level].cap
	if cap==Vector2.ZERO: return
	# The rendered capstan reaches radius 51 and the rope is about 9 px wide.
	# Keep free samples outside 60 px so a valid wrap cannot cross solid metal.
	for i in range(1,N-1):
		if i==grabbed or pinned.has(i): continue
		var radial:=points[i]-cap
		if radial.length()<60.0:
			if radial.length_squared()<.001: radial=Vector2.RIGHT
			points[i]=cap+radial.normalized()*60.0

func _evaluate(delta: float) -> void:
	finite_state=true
	for p in points:
		if not is_finite(p.x) or not is_finite(p.y): finite_state=false
	route_ok=_route(); wrap_ok=_wrap(); tautness=_taut(); taut_ok=tautness>=.74
	var now=[route_ok,wrap_ok,docked,taut_ok]
	for i in range(4):
		var relevant: bool = (i == 0 and levels[level].route) or (i == 1 and levels[level].wrap) or i >= 2
		if relevant and now[i]!=prior[i]:
			transitions+=1
			if now[i]:
				if i == 0: verbs.thread = true
				elif i == 1: verbs.loop = true
				elif i == 3: verbs.tension = true
	prior=now
	if taut_ok and not tension_cued:
		tension_cued=true
		_play_cue("tension")
	elif tautness<.46:
		tension_cued=false
	visited_levels[level] = true
	var d: Dictionary=levels[level]
	var prereq: bool=(route_ok or not d.route) and (wrap_ok or not d.wrap)
	var target=tautness if prereq else 0.0
	load_height=move_toward(load_height,target,delta*(1.5 if level==3 else 2.2))
	if level==3: max_load=maxf(max_load,load_height)
	var goal: bool=prereq and docked and taut_ok and (level<3 or load_height>=.62)
	if goal and not solved:
		hold+=delta
		if hold>=.42: _solve()
	elif not solved: hold=maxf(0,hold-delta*2)

func _route() -> bool:
	var eyes: Array=levels[level].eyes
	route_signature=thread_sequence.duplicate()
	if eyes.is_empty(): return true
	if thread_sequence.size()<eyes.size(): return false
	for i in range(eyes.size()):
		if thread_sequence[i]!=i: return false
	return true

func _wrap() -> bool:
	var c: Vector2=levels[level].cap
	if c==Vector2.ZERO: winding=0; return true
	# Winding is evaluated per continuous annular interval. Combining angle,
	# sample count, or radial span across separated contacts would let two
	# disconnected half-turns impersonate one load-bearing loop.
	winding=topology_winding
	var run_winding:=0.0
	var run_samples:=0
	var run_radial_min:=9999.0
	var run_radial_max:=0.0
	var accepted:=false
	for i in range(N-1):
		var a=points[i]-c; var b=points[i+1]-c
		if a.length()>=60 and a.length()<=122 and b.length()>=60 and b.length()<=122:
			run_winding+=wrapf(b.angle()-a.angle(),-PI,PI)
			run_samples+=1
			run_radial_min=minf(run_radial_min,minf(a.length(),b.length()))
			run_radial_max=maxf(run_radial_max,maxf(a.length(),b.length()))
		else:
			if absf(run_winding)>absf(winding): winding=run_winding
			if run_samples>=9 and run_winding>=TAU*.88 and run_radial_max-run_radial_min<=68.0: accepted=true
			run_winding=0; run_samples=0; run_radial_min=9999; run_radial_max=0
	if absf(run_winding)>absf(winding): winding=run_winding
	if run_samples>=9 and run_winding>=TAU*.88 and run_radial_max-run_radial_min<=68.0: accepted=true
	return topology_winding>=TAU*.88 or accepted

func _taut() -> float:
	if points.size()<9: return 0
	var start=N-9; var path=0.0
	for i in range(start,N-1): path+=points[i].distance_to(points[i+1])
	var chord=points[start].distance_to(points[N-1])
	var straightness:=clampf(chord/maxf(path,1),0,1)
	var extension:=clampf(path/(_segment_length()*8),0,1)
	return straightness*extension

func _seg_dist(p:Vector2,a:Vector2,b:Vector2)->float:
	var ab=b-a
	if ab.length_squared()<.001:return p.distance_to(a)
	return p.distance_to(a+ab*clampf((p-a).dot(ab)/ab.length_squared(),0,1))

func _solve()->void:
	solved=true; goals+=1; solved_levels[level]=true; pulse=1; verbs.tension=true; _burst(levels[level].cleat,22)
	if level==3:
		bell_pulse=1.0
		_play_cue("bell")
	else: _play_cue("success")

func _build_audio()->void:
	# Tiny PCM instruments are generated at startup: no imported assets and no
	# ambience. Three voices allow physical cues to overlap naturally.
	for i in range(3):
		var player:=AudioStreamPlayer.new()
		player.volume_db=-8.0
		add_child(player)
		audio_players.append(player)
	var specs:={
		"grab":{"notes":[118.0],"duration":.055,"noise":.18},
		"dock":{"notes":[410.0,615.0],"duration":.11,"noise":.06},
		"release":{"notes":[245.0],"duration":.08,"noise":.10},
		"pin":{"notes":[330.0,495.0],"duration":.09,"noise":.08},
		"reject":{"notes":[105.0],"duration":.10,"noise":.22},
		"tension":{"notes":[185.0,277.5],"duration":.16,"noise":.04},
		"reset":{"notes":[170.0],"duration":.10,"noise":.14},
		"success":{"notes":[220.0,275.0,330.0],"duration":.42,"noise":.015},
		"bell":{"notes":[392.0,784.0,1176.0],"duration":.72,"noise":.01}
	}
	for cue in specs:
		var spec:Dictionary=specs[cue]
		audio_streams[cue]=_synth_stream(spec.notes,float(spec.duration),float(spec.noise))

func _play_cue(kind:String)->void:
	if audio_players.is_empty() or factory_mode or not audio_streams.has(kind): return
	var player:=audio_players[audio_cursor%audio_players.size()]
	audio_cursor+=1
	player.stream=audio_streams[kind]
	player.play()

func _synth_stream(frequencies:Array,duration:float,noise:float)->AudioStreamWAV:
	var rate:=22050
	var frames:=int(duration*rate)
	var pcm:=PackedByteArray()
	pcm.resize(frames*2)
	for i in range(frames):
		var t:=float(i)/rate
		var envelope:=pow(1.0-float(i)/frames,2.2)*minf(1.0,t/.012)
		var value:=0.0
		for frequency in frequencies: value+=sin(TAU*frequency*t)/frequencies.size()
		# Deterministic fiber texture avoids consuming the gameplay RNG stream.
		value+=sin(float(i*i%997)*.37)*noise
		pcm.encode_s16(i*2,int(clampf(value*envelope,-1,1)*25000.0))
	var stream:=AudioStreamWAV.new()
	stream.format=AudioStreamWAV.FORMAT_16_BITS
	stream.mix_rate=rate
	stream.stereo=false
	stream.data=pcm
	return stream

func _burst(origin:Vector2,count:int)->void:
	for i in range(count): fibers.append({"p":origin,"v":Vector2.from_angle(i*2.399)*float(35+(i%5)*12),"life":.65})

func _draw()->void:
	draw_rect(Rect2(Vector2.ZERO,VIEW),SLATE)
	for x in range(0,1152,48): draw_line(Vector2(x,124),Vector2(x,720),Color(0.25,0.35,0.36,.12),1)
	for y in range(124,720,48): draw_line(Vector2(0,y),Vector2(1152,y),Color(0.25,0.35,0.36,.12),1)
	if not started: _draw_title(); return
	_draw_header(); _draw_machine(); _draw_fixtures(); _draw_rope(); _draw_fixture_occlusion(); _draw_status()

func _font()->Font:return ThemeDB.fallback_font

func _draw_title()->void:
	draw_circle(Vector2(576,317),138,Color("172326"))
	for r in range(4): draw_arc(Vector2(576,317),62+r*17,-2.7+r*.25,2.1+r*.2,48,FLAX.darkened(.08*r),7,true)
	draw_string(_font(),Vector2(392,160),"K N O T   T H E O R Y",HORIZONTAL_ALIGNMENT_CENTER,370,34,BONE)
	draw_string(_font(),Vector2(392,202),"EYELET TO HOIST",HORIZONTAL_ALIGNMENT_CENTER,370,17,BRASS)
	draw_string(_font(),Vector2(352,500),"One rope. Four small machines.",HORIZONTAL_ALIGNMENT_CENTER,450,20,CHALK)
	_button(Rect2(456,548,240,58),"BEGIN")
	draw_string(_font(),Vector2(346,650),"DRAG  ·  RIGHT-CLICK TO PIN  ·  R RESET  ·  ESC TITLE",HORIZONTAL_ALIGNMENT_CENTER,460,13,CHALK)

func _draw_header()->void:
	draw_rect(Rect2(0,0,1152,124),Color("0d1517"))
	var d:Dictionary=levels[level]
	draw_string(_font(),Vector2(40,42),d.mark,HORIZONTAL_ALIGNMENT_LEFT,110,14,BRASS)
	draw_string(_font(),Vector2(40,78),d.name,HORIZONTAL_ALIGNMENT_LEFT,520,30,BONE)
	draw_string(_font(),Vector2(40,105),d.lesson,HORIZONTAL_ALIGNMENT_LEFT,700,14,CHALK)
	_button(Rect2(974,35,142,48),"RESET  R",14)

func _draw_fixtures()->void:
	var d:Dictionary=levels[level]
	for c in d.eyes:
		draw_circle(c+Vector2(5,7),46,Color(0,0,0,.34)); draw_arc(c,42,0,TAU,48,LIT if route_ok else BRASS,12,true); draw_circle(c,27,Color("1a282b")); draw_arc(c,27,0,TAU,40,BONE if route_ok else CHALK,2,true)
	if d.cap!=Vector2.ZERO:
		var c:Vector2=d.cap; draw_circle(c+Vector2(7,9),55,Color(0,0,0,.4)); draw_circle(c,51,Color("6b4a27")); draw_circle(c,34,BRASS); draw_circle(c,13,Color("30281f")); draw_arc(c,72,-PI/2,-PI/2+clampf(winding/(TAU*.88),-1,1)*TAU,48,LIT if winding>0 else CORAL,5,true)
	var c:Vector2=d.cleat
	draw_line(c+Vector2(-25,14),c+Vector2(25,-14),Color("422e1d"),18,true); draw_line(c+Vector2(-29,10),c+Vector2(29,-10),LIT if docked else BRASS,10,true); draw_circle(c,12,BONE if docked else Color("6b4a27")); draw_string(_font(),c+Vector2(-42,48),"CLEAT",HORIZONTAL_ALIGNMENT_CENTER,84,12,CHALK)

func _draw_machine()->void:
	if level==1:
		var y=lerpf(550,455,load_height); draw_line(Vector2(620,435),Vector2(620,y),BRASS.darkened(.3),3); draw_rect(Rect2(585,y,70,58),Color("8c5934")); draw_string(_font(),Vector2(594,y+35),"LOAD",HORIZONTAL_ALIGNMENT_CENTER,52,12,BONE)
	elif level==2:
		draw_rect(Rect2(730,220,120,32),Color("253438")); draw_line(Vector2(730,236),Vector2(lerpf(730,785,load_height),236),BRASS,12,true)
	elif level==3:
		var y=lerpf(252,150,load_height); draw_rect(Rect2(893,150,158,155),Color("0b1113"));
		for i in range(5):draw_rect(Rect2(903,y+i*25,138,17),Color("715038"))
		draw_line(Vector2(968,144),Vector2(968,185),BRASS,4); draw_arc(Vector2(968,205),27,PI,TAU,24,LIT if load_height>.6 else BRASS,9,true); draw_circle(Vector2(968,230),5,LIT)
		if bell_pulse>0:
			for ray in range(8):
				var direction:=Vector2.from_angle(float(ray)*TAU/8.0)
				draw_line(Vector2(968,205)+direction*38,Vector2(968,205)+direction*(46+18*(1-bell_pulse)),Color(LIT,bell_pulse),3,true)

func _draw_rope()->void:
	if points.size()<2:return
	var rope=PackedVector2Array(points); draw_polyline(rope,Color(0,0,0,.48),16,true); draw_polyline(rope,LIT if taut_ok else FLAX,9 if grabbed>=0 else 8,true); draw_polyline(rope,Color(1,.88,.62,.22),2,true)
	if hover>=0 and grabbed<0:draw_arc(points[hover],18,0,TAU,24,BONE,2,true)
	if grabbed>=0:
		draw_circle(points[grabbed],20,Color(SLATE,.76))
		draw_arc(points[grabbed],20,-2.5,2.5,24,LIT,4,true)
		draw_circle(points[grabbed],6,BONE)
	for index in pinned:
		draw_circle(points[index],15,Color("392919"))
		draw_line(points[index]+Vector2(-10,10),points[index]+Vector2(10,-10),BRASS,8,true)
		draw_circle(points[index],5,BONE)
	if reject_pulse>0:
		draw_arc(reject_position,18+(1-reject_pulse)*18,-2.7,2.7,24,Color(CORAL,reject_pulse),4,true)
	for i in [0,N-1]:draw_circle(points[i],12,BONE);draw_circle(points[i],6,BRASS)

func _draw_fixture_occlusion()->void:
	# Foreground lips make a threaded strand disappear behind metal at contact,
	# while leaving it visible through each aperture.
	var d: Dictionary=levels[level]
	for c in d.eyes:
		draw_arc(c,42,-2.75,-0.38,24,LIT if route_ok else BRASS,12,true)
		draw_arc(c,42,0.40,2.76,24,LIT if route_ok else BRASS,12,true)
	if d.cap!=Vector2.ZERO:
		draw_arc(d.cap,51,0.10,PI-0.10,28,Color("805b31"),7,true)
		draw_circle(d.cap,13,Color("30281f"))

func _draw_status()->void:
	var x=38.0
	for item in [["THREAD",route_ok,levels[level].route],["LOOP",wrap_ok,levels[level].wrap],["TENSION",taut_ok,true],["DOCK",docked,true]]:
		if not item[2]:continue
		draw_circle(Vector2(x+7,678),6,LIT if item[1] else Color("3b4b4e"));draw_string(_font(),Vector2(x+19,683),item[0],HORIZONTAL_ALIGNMENT_LEFT,88,12,BONE if item[1] else CHALK);x+=116
	if pulse>0:draw_arc(levels[level].cleat,52+(1-pulse)*95,0,TAU,60,Color(LIT,pulse*.7),4,true)
	for f in fibers:draw_line(f.p,f.p-f.v.normalized()*7,Color(LIT,clampf(f.life,0,1)),2)
	if solved:
		draw_rect(Rect2(326,284,500,152),Color(0.04,.08,.09,.94));draw_rect(Rect2(326,284,500,152),LIT,false,2);draw_string(_font(),Vector2(376,334),"LINE HOLDS",HORIZONTAL_ALIGNMENT_CENTER,400,28,BONE);draw_string(_font(),Vector2(376,366),"The rope remembers the work you taught it.",HORIZONTAL_ALIGNMENT_CENTER,400,15,CHALK);_button(Rect2(476,383,200,38),"REPLAY" if level==3 else "NEXT",16)

func _button(r:Rect2,text:String,size:=17)->void:
	draw_rect(r,Color("233236"));draw_rect(r,BRASS,false,2);draw_string(_font(),Vector2(r.position.x,r.position.y+r.size.y*.63),text,HORIZONTAL_ALIGNMENT_CENTER,r.size.x,size,BONE)

# Deterministic scenario: negative fixtures probe recognizer boundaries, while
# positive completion moves the working end through the same _drag_to path as
# real mouse input. The test never replaces the rope with a solved shape.
func factory_setup(parameters:Dictionary)->void:
	factory_mode=true;started=true;level=0;factory_ticks=0;factory_drag_samples=0;solved_levels.clear();visited_levels.clear();near_misses.clear();verbs.clear();transitions=0;goals=0;resets=0;progressions=0;replays=0;invalid_cases=0;max_load=0;_reset(false);visited_levels[level]=true

func factory_tick(tick:int)->void:
	factory_ticks=tick+1;var phase=tick%120
	if phase==3: _factory_drag(false)
	if phase==7:
		_evaluate(1.0/60.0)
		var d: Dictionary=levels[level]
		var rejected: bool=(d.route and not route_ok) or (d.wrap and not wrap_ok) or (not d.route and not d.wrap and not docked)
		if rejected:
			invalid_cases+=1
			if not d.route and not d.wrap: near_misses.undocked_goal=true
			elif d.wrap and level==2: near_misses.partial_wrap=true
			elif d.wrap: near_misses.reversed_wrap=true
			else: near_misses.missed_eye=true
	if phase==10 and levels[level].wrap:
		_factory_discontinuous_wrap()
		if not wrap_ok: invalid_cases+=1; near_misses.discontinuous_wrap=true
	if phase==14: _reset(false); _factory_begin_player_drag()
	if phase>=15 and phase<55: _factory_step_player_drag(phase-15)
	if phase==55: _factory_release(levels[level].cleat)
	if phase>=56 and phase<88: _evaluate(1.0/60.0)
	if phase==89 and solved: _press(Vector2(576,402))
	if phase==100: _reset()

func _factory_drag(valid:bool)->void:
	var d:Dictionary=levels[level];var anchors:Array[Vector2]=[d.start]
	if d.route:
		var eyes:Array=d.eyes.duplicate()
		if not valid:eyes.reverse()
		for eye in eyes:anchors.append(eye if valid else eye+Vector2(0,52))
	if d.wrap:
		var direction: float=1.0 if valid or level==2 else -1.0
		var steps: int=20 if valid or level==3 else 8
		for step in range(steps):anchors.append(d.cap+Vector2.from_angle(-2.2+direction*step*.48)*76)
	anchors.append(d.cleat if valid else d.end);points=_resample(anchors,N);docked=false
	# Use the same constraint relaxation used by direct manipulation. Holding the
	# working end mirrors a player drag and avoids a test-only frozen rope.
	grabbed=N-1; verbs.pull=true; _relax(2); _evaluate(1.0/60.0)

func _factory_begin_player_drag()->void:
	var d:Dictionary=levels[level]
	var anchors:Array[Vector2]=[points[N-1]]
	for eye in d.eyes:
		anchors.append(eye)
	if d.wrap:
		var start_angle:float=(anchors[-1]-d.cap).angle()
		# Positive screen-space angle is clockwise. A little more than one turn
		# gives the physical solver room to settle while retaining a full wrap.
		for step in range(21):
			anchors.append(d.cap+Vector2.from_angle(start_angle+float(step)*TAU*1.04/20.0)*76.0)
	anchors.append(d.cleat)
	# This resamples the cursor trajectory, not the rope. Every sample is then
	# applied incrementally through the production drag primitive.
	factory_path=_resample(anchors,40)
	grabbed=N-1

func _factory_step_player_drag(step:int)->void:
	if factory_path.is_empty(): return
	_drag_to(factory_path[mini(step,factory_path.size()-1)])
	factory_drag_samples+=1
	_evaluate(1.0/60.0)

func _factory_discontinuous_wrap()->void:
	var d: Dictionary=levels[level]
	# Two qualifying half-turns separated by an out-of-annulus bridge. Their
	# total signed angle exceeds a turn, but no continuous interval does.
	var anchors:Array[Vector2]=[d.start]
	for step in range(10): anchors.append(d.cap+Vector2.from_angle(-2.35+step*(PI/9.0))*76.0)
	anchors.append(d.cap+Vector2(165,-18))
	anchors.append(d.cap+Vector2(165,18))
	for step in range(10): anchors.append(d.cap+Vector2.from_angle(-2.35+step*(PI/9.0))*76.0)
	anchors.append(d.end)
	points=_resample(anchors,N);docked=false;grabbed=N-1;_evaluate(1.0/60.0)

func _factory_release(position:Vector2)->void:
	grabbed=N-1
	points[N-1]=position
	_release(position)

func _resample(a:Array[Vector2],count:int)->Array[Vector2]:
	var out:Array[Vector2]=[];var lens:Array[float]=[];var total=0.0
	for i in range(a.size()-1):var length=a[i].distance_to(a[i+1]);lens.append(length);total+=length
	for s in range(count):
		var target=total*float(s)/float(count-1);var acc=0.0
		for i in range(lens.size()):
			if target<=acc+lens[i] or i==lens.size()-1:out.append(a[i].lerp(a[i+1],clampf((target-acc)/maxf(lens[i],.001),0,1)));break
			acc+=lens[i]
	return out

func factory_sample()->Dictionary:
	return {"level":level+1,"rope_points":points.size(),"finite_state":finite_state,"route_signature":route_signature.duplicate(),"route_valid":route_ok,"signed_winding":snappedf(winding,.001),"wrap_valid":wrap_ok,"docked":docked,"tautness":snappedf(tautness,.001),"load_height":snappedf(load_height,.001),"invalid_contacts":invalid_cases,"near_misses":near_misses.keys(),"predicate_transitions":transitions,"goal_transitions":goals,"success_latched":solved,"verbs":verbs.keys(),"player_drag_samples":factory_drag_samples}

func factory_collect()->Dictionary:
	var sf=float(solved_levels.size())/4.0;var vf=clampf(float(verbs.size())/5,0,1);var tf=clampf(float(transitions)/12,0,1);var nf=clampf(float(progressions+resets+replays)/8,0,1);var score=sf*.4+vf*.18+tf*.17+nf*.1+clampf(max_load,0,1)*.15;var violations:Array=[]
	if not finite_state:violations.append({"code":"knot-theory.non-finite","message":"Non-finite rope coordinate.","severity":"error"})
	if solved_levels.size()<4:violations.append({"code":"knot-theory.goal-coverage","message":"Not all four geometric goals were observed.","severity":"error"})
	if visited_levels.size()<4 or progressions<3 or replays<1:violations.append({"code":"knot-theory.navigation","message":"Progression and replay paths were not fully observed.","severity":"error"})
	if near_misses.size()<5:violations.append({"code":"knot-theory.near-misses","message":"Required route and wrap near-misses were not all rejected.","severity":"error"})
	if verbs.size()<3:violations.append({"code":"knot-theory.verbs","message":"Fewer than three verbs observed.","severity":"error"})
	if factory_drag_samples<160:violations.append({"code":"knot-theory.player-input-coverage","message":"Successful scenarios did not exercise all incremental player drag samples.","severity":"error"})
	return {"metrics":{"scenario_score":snappedf(score,.001),"rope_points":points.size(),"levels_playable":visited_levels.size(),"goals_detected":goals,"interaction_modes":verbs.size(),"predicate_transitions":transitions,"solved_levels":solved_levels.size(),"finale_load_displacement":snappedf(max_load,.001),"invalid_cases_observed":invalid_cases,"near_miss_types":near_misses.size(),"reset_coverage":resets,"progression_coverage":progressions,"replay_coverage":replays,"player_drag_samples":factory_drag_samples},"violations":violations}
