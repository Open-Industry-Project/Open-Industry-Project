@tool
extends Node3D
class_name Roller

const RADIUS: float = 0.12
const BASE_LENGTH: float = 2.0
const BASE_CYLINDER_LENGTH: float = 0.935097 * 2.0

var speed: float = 0.0
var global_front: Vector3 = Vector3.ZERO

var static_body: StaticBody3D
var left_end_mesh: MeshInstance3D
var right_end_mesh: MeshInstance3D
var cylinder_mesh: MeshInstance3D

func _enter_tree() -> void:
	set_notify_transform(true)
	update_global_front()
	update_physics()

func _exit_tree() -> void:
	set_notify_transform(false)

func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		update_global_front()

func update_global_front() -> void:
	# Ensure we're inside the tree before updating
	if not is_inside_tree():
		return
	var new_global_front: Vector3 = global_basis.z.normalized()
	if global_front != new_global_front:
		global_front = new_global_front
		update_physics()

func ensure_node_references_initialized() -> void:
	if static_body == null:
		static_body = get_node("StaticBody3D") as StaticBody3D
	if left_end_mesh == null:
		left_end_mesh = get_node("RollerMeshes/RollerEndL") as MeshInstance3D
	if right_end_mesh == null:
		right_end_mesh = get_node("RollerMeshes/RollerEndR") as MeshInstance3D
	if cylinder_mesh == null:
		cylinder_mesh = get_node("RollerMeshes/RollerLength") as MeshInstance3D

func set_speed(new_speed: float) -> void:
	speed = new_speed
	update_physics()

func update_physics() -> void:
	ensure_node_references_initialized()
	static_body.constant_angular_velocity = -global_front * speed / RADIUS

func set_length(length: float) -> void:
	ensure_node_references_initialized()
	left_end_mesh.position = Vector3(0, 0, -length / BASE_LENGTH)
	right_end_mesh.position = Vector3(0, 0, length / BASE_LENGTH)
	
	# Keep a constant margin at the ends of the cylinder.
	var cylinder_margins: float = BASE_LENGTH - BASE_CYLINDER_LENGTH
	var new_cylinder_length: float = length - cylinder_margins
	cylinder_mesh.scale = Vector3(1, 1, new_cylinder_length / BASE_CYLINDER_LENGTH)
	
	# Apply the same scaling to the static body.
	static_body.scale = Vector3(1, 1, new_cylinder_length / BASE_CYLINDER_LENGTH)

func set_roller_override_material(material: Material) -> void:
	ensure_node_references_initialized()
	left_end_mesh.set_surface_override_material(0, material)
	right_end_mesh.set_surface_override_material(0, material)
	cylinder_mesh.set_surface_override_material(0, material)
