@tool
class_name DiverterAnimator
extends Node3D

enum LightColor {
	Red = 3,
	Green = 4
}

var pusher_mesh_instance: MeshInstance3D
var red_light_material: StandardMaterial3D
var green_light_material: StandardMaterial3D

var part1: MeshInstance3D
var part1_start_pos: Vector3
var part1_maximum_z_pos: float = 0.32

var part2: MeshInstance3D
var part2_start_pos: Vector3
var part2_maximum_z_pos: float = 0.65

var part_end: RigidBody3D
var part_end_start_pos: Vector3
var part_end_maximum_z_pos: float = 1.0

var firing: bool = false

func _ready() -> void:
	pusher_mesh_instance = $Pusher
	pusher_mesh_instance.mesh = pusher_mesh_instance.mesh.duplicate()
	red_light_material = (pusher_mesh_instance.mesh.surface_get_material(3)).duplicate() as StandardMaterial3D
	green_light_material = (pusher_mesh_instance.mesh.surface_get_material(4)).duplicate() as StandardMaterial3D
	pusher_mesh_instance.mesh.surface_set_material(3, red_light_material)
	pusher_mesh_instance.mesh.surface_set_material(4, green_light_material)
	
	part1 = $Pusher/part1
	part1_start_pos = part1.position
	
	part2 = $Pusher/part2
	part2_start_pos = part2.position
	
	part_end = $Pusher/PartEnd
	part_end_start_pos = part_end.position

func set_lamp_light(light_color: int, enabled: bool) -> void:
	var current_material = pusher_mesh_instance.mesh.surface_get_material(light_color) as StandardMaterial3D
	if enabled:
		current_material.emission_energy_multiplier = 1.0
	else:
		current_material.emission_energy_multiplier = 0.0

func push(time: float, distance: float) -> void:
	set_lamp_light(LightColor.Green, true)
	var tween = get_tree().create_tween()
	var forward = Vector3.FORWARD
	tween.parallel().tween_property(part1, "position", part1_start_pos + forward * part1_maximum_z_pos * distance, time)
	tween.parallel().tween_property(part2, "position", part2_start_pos + forward * part2_maximum_z_pos * distance, time)
	tween.parallel().tween_property(part_end, "position", part_end_start_pos + forward * part_end_maximum_z_pos * distance, time)
	tween.tween_callback(Callable(self, "return_phase"))
	tween.parallel().tween_property(part1, "position", part1_start_pos, time)
	tween.parallel().tween_property(part2, "position", part2_start_pos, time)
	tween.parallel().tween_property(part_end, "position", part_end_start_pos, time)
	tween.tween_callback(Callable(self, "finish"))

func return_phase() -> void:
	set_lamp_light(LightColor.Green, false)
	set_lamp_light(LightColor.Red, true)

func finish() -> void:
	set_lamp_light(LightColor.Red, false)
	firing = false

func Fire(time: float, distance: float) -> void:
	if not firing:
		firing = true
		push(time, distance)

func Disable() -> void:
	finish()
