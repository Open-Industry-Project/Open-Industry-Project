extends Node3D

# Perpendicular-transfer test: belt A conveys +X, belt B conveys +Z. A long box
# rides A into B and should YAW to follow belt B (not just slide diagonally).
# `-- noyaw` sets angular_gain=0 (expect ~0 rotation -> regression knob).

const CT := preload("res://src/Conveyor/conveyor_transport.gd")
const BOXSZ := Vector3(2.54, 0.4, 0.4)

var _box: RigidBody3D
var _frame := 0
var _peak_wy := 0.0


func _make_belt(min_x: float, max_x: float, vel: Vector3, name_: String) -> void:
	var b := StaticBody3D.new()
	b.name = name_
	var m := PhysicsMaterial.new()
	m.friction = 0.5
	b.physics_material_override = m
	var cs := CollisionShape3D.new()
	var sh := BoxShape3D.new()
	sh.size = Vector3(max_x - min_x, 0.5, 28.0)
	cs.shape = sh
	b.add_child(cs)
	add_child(b)
	b.global_position = Vector3((min_x + max_x) * 0.5, -0.25, 10.0)
	b.constant_linear_velocity = vel
	b.add_to_group(CT.SURFACE_GROUP)


func _ready() -> void:
	CT.angular_gain = 0.0 if OS.get_cmdline_user_args().has("noyaw") else 0.5
	_make_belt(-8.0, 0.1, Vector3(1.0, 0.0, 0.0), "BeltA_X")
	_make_belt(0.0, 8.0, Vector3(0.0, 0.0, 1.0), "BeltB_Z")

	_box = RigidBody3D.new()
	_box.mass = 10.0
	var bm := PhysicsMaterial.new()
	bm.friction = 0.5
	_box.physics_material_override = bm
	var cs := CollisionShape3D.new()
	var sh := BoxShape3D.new()
	sh.size = BOXSZ
	cs.shape = sh
	_box.add_child(cs)
	add_child(_box)
	_box.global_position = Vector3(-2.0, 0.2, 0.0)
	_box.linear_velocity = Vector3(1.0, 0.0, 0.0)

	print("PERP,gain=%.1f" % CT.angular_gain)
	print("PERP,frame,cx,cz,yaw_deg,wy,vx,vz")


func _physics_process(delta: float) -> void:
	_frame += 1
	if _frame <= 2:
		return
	CT.drive_body(_box, BOXSZ, delta)

	var p := _box.global_position
	var yaw := rad_to_deg(_box.global_rotation.y)
	var wy := _box.angular_velocity.y
	var v := _box.linear_velocity
	if absf(wy) > absf(_peak_wy):
		_peak_wy = wy

	if _frame % 8 == 0:
		print("PERP,%d,%.2f,%.2f,%.1f,%.2f,%.2f,%.2f" % [_frame, p.x, p.z, yaw, wy, v.x, v.z])

	if _frame > 500:
		print("PERP_SUMMARY,final_yaw_deg=%.1f,peak_wy=%.2f,final_vx=%.2f,final_vz=%.2f" % [
				yaw, _peak_wy, v.x, v.z])
		get_tree().quit()
