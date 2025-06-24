@tool
class_name DiverterAnimator
extends Node3D

enum LightColor {
	Red = 3,
	Green = 4
}

var _pusher_mesh_instance: MeshInstance3D
var _red_light_material: StandardMaterial3D
var _green_light_material: StandardMaterial3D
var _part1: MeshInstance3D
var _part1_start_pos: Vector3
var _part1_maximum_z_pos: float = 0.32
var _part2: MeshInstance3D
var _part2_start_pos: Vector3
var _part2_maximum_z_pos: float = 0.65
var _part_end: RigidBody3D
var _part_end_start_pos: Vector3
var _part_end_maximum_z_pos: float = 1.0
var _firing: bool = false


func _ready() -> void:
	_pusher_mesh_instance = $Pusher
	_pusher_mesh_instance.mesh = _pusher_mesh_instance.mesh.duplicate()
	_red_light_material = (_pusher_mesh_instance.mesh.surface_get_material(3)).duplicate() as StandardMaterial3D
	_green_light_material = (_pusher_mesh_instance.mesh.surface_get_material(4)).duplicate() as StandardMaterial3D
	_pusher_mesh_instance.mesh.surface_set_material(3, _red_light_material)
	_pusher_mesh_instance.mesh.surface_set_material(4, _green_light_material)

	_part1 = $Pusher/part1
	_part1_start_pos = _part1.position

	_part2 = $Pusher/part2
	_part2_start_pos = _part2.position

	_part_end = $Pusher/PartEnd
	_part_end_start_pos = _part_end.position


func fire(time: float, distance: float) -> void:
	if not _firing:
		_part_end.freeze_mode = RigidBody3D.FREEZE_MODE_KINEMATIC
		_firing = true
		_push(time, distance)


func disable() -> void:
	_finish()


func _set_lamp_light(light_color: int, enabled: bool) -> void:
	var current_material := _pusher_mesh_instance.mesh.surface_get_material(light_color) as StandardMaterial3D
	if enabled:
		current_material.emission_energy_multiplier = 1.0
	else:
		current_material.emission_energy_multiplier = 0.0


func _push(time: float, distance: float) -> void:
	_set_lamp_light(LightColor.Green, true)
	var tween := get_tree().create_tween()
	var forward := Vector3.FORWARD
	tween.parallel().tween_property(_part1, "position", _part1_start_pos + forward * _part1_maximum_z_pos * distance, time)
	tween.parallel().tween_property(_part2, "position", _part2_start_pos + forward * _part2_maximum_z_pos * distance, time)
	tween.parallel().tween_property(_part_end, "position", _part_end_start_pos + forward * _part_end_maximum_z_pos * distance, time)
	tween.tween_callback(Callable(self, "_return_phase"))
	tween.parallel().tween_property(_part1, "position", _part1_start_pos, time)
	tween.parallel().tween_property(_part2, "position", _part2_start_pos, time)
	tween.parallel().tween_property(_part_end, "position", _part_end_start_pos, time)
	tween.tween_callback(Callable(self, "_finish"))


func _return_phase() -> void:
	_set_lamp_light(LightColor.Green, false)
	_set_lamp_light(LightColor.Red, true)


func _finish() -> void:
	_part_end.freeze_mode = RigidBody3D.FREEZE_MODE_STATIC
	_set_lamp_light(LightColor.Red, false)
	_firing = false
