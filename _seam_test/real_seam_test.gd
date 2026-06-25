extends Node3D

# Parallel-transfer regression: REAL BeltConveyor + Box parts, game-mode headless.
# `-- nodrive` disables ConveyorTransport. The DRIVE ramp must match the prior
# run (first_accel~0.1, midpoint~0.6) — the per-sample rewrite must not change it.

const CT := preload("res://src/Conveyor/conveyor_transport.gd")
const BELT := preload("res://parts/BeltConveyor.tscn")
const BOX := preload("res://parts/Box.tscn")

const V_UP := 1.0
const V_DOWN := 3.0
const BOX_LEN := 2.54
const BOX_H := 0.4
const BOX_W := 0.4
const MAX_FRAMES := 1200

var _belt_a: Node3D
var _belt_b: Node3D
var _box: Node3D
var _rb: RigidBody3D
var _seam_x := 0.0
var _top_y := 0.0
var _state := 0
var _frame := 0
var _t_first := -1.0
var _t_mid := -1.0
var _t_near := -1.0


func _belt_extent(belt: Node3D) -> Dictionary:
	var min_x := INF
	var max_x := -INF
	var top_y := -INF
	for b: Node in get_tree().get_nodes_in_group(CT.SURFACE_GROUP):
		if not belt.is_ancestor_of(b):
			continue
		var cs := b.get_node_or_null("CollisionShape3D") as CollisionShape3D
		if cs == null or not (cs.shape is BoxShape3D):
			continue
		var hf: Vector3 = (cs.shape as BoxShape3D).size * 0.5
		var o: Vector3 = (b as Node3D).global_transform.origin
		min_x = minf(min_x, o.x - hf.x)
		max_x = maxf(max_x, o.x + hf.x)
		top_y = maxf(top_y, o.y + hf.y)
	return {"min_x": min_x, "max_x": max_x, "top_y": top_y}


func _ready() -> void:
	CT.enabled = not OS.get_cmdline_user_args().has("nodrive")
	_belt_a = BELT.instantiate()
	add_child(_belt_a)
	_belt_a.set("length", 6.0)
	_belt_a.set("speed", V_UP)
	_belt_b = BELT.instantiate()
	add_child(_belt_b)
	_belt_b.set("length", 12.0)
	_belt_b.set("speed", V_DOWN)
	print("SEAM,mode=%s" % ("DRIVE" if CT.enabled else "BASELINE"))


func _physics_process(delta: float) -> void:
	_frame += 1
	if _state == 0:
		if _frame < 3:
			return
		var ea := _belt_extent(_belt_a)
		var eb0 := _belt_extent(_belt_b)
		var pulley := 0.5 * float(_belt_a.get("height"))
		var seam_visual: float = ea["max_x"] - pulley
		var b_visual_start0: float = eb0["min_x"] + pulley
		_belt_b.global_position.x += seam_visual - b_visual_start0
		_seam_x = seam_visual
		_top_y = ea["top_y"]
		_box = BOX.instantiate()
		add_child(_box)
		_box.set("size", Vector3(BOX_LEN, BOX_H, BOX_W))
		_box.set("initial_linear_velocity", Vector3(V_UP, 0, 0))
		_box.global_position = Vector3(_seam_x - 2.0, _top_y + BOX_H * 0.5, 0.0)
		_state = 1
		return
	if _state == 1:
		Simulation.start()
		_rb = _box.get_node("RigidBody3D") as RigidBody3D
		print("SEAM,frame,center_x,frac_on_down,vel_x")
		_state = 2
		return

	if _rb == null:
		return
	var cx := _rb.global_position.x
	var vx := _rb.linear_velocity.x
	var frac := clampf(cx + BOX_LEN * 0.5 - _seam_x, 0.0, BOX_LEN) / BOX_LEN
	if _frame % 3 == 0:
		print("SEAM,%d,%.3f,%.3f,%.3f" % [_frame, cx, frac, vx])
	if _t_first < 0.0 and vx > V_UP + 0.1:
		_t_first = frac
	if _t_mid < 0.0 and vx >= (V_UP + V_DOWN) * 0.5:
		_t_mid = frac
	if _t_near < 0.0 and vx >= V_DOWN - 0.1:
		_t_near = frac
	if cx > _seam_x + 4.0 or _frame > MAX_FRAMES:
		print("SEAM_SUMMARY,first_accel_frac=%.3f,midpoint_frac=%.3f,near_down_frac=%.3f" % [
				_t_first, _t_mid, _t_near])
		_rb = null
		get_tree().quit()
