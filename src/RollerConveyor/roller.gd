@tool
class_name Roller
extends Node3D

const RADIUS: float = 0.12
const BASE_LENGTH: float = 2.0
const BASE_CYLINDER_LENGTH: float = 0.935097 * 2.0

var _left_end_mesh: MeshInstance3D
var _right_end_mesh: MeshInstance3D
var _cylinder_mesh: MeshInstance3D

func _enter_tree() -> void:
	_ensure_node_references_initialized()

func set_length(length: float) -> void:
	_ensure_node_references_initialized()
	_left_end_mesh.position = Vector3(0, 0, -length / BASE_LENGTH)
	_right_end_mesh.position = Vector3(0, 0, length / BASE_LENGTH)

	var cylinder_margins := BASE_LENGTH - BASE_CYLINDER_LENGTH
	var new_cylinder_length := length - cylinder_margins
	_cylinder_mesh.scale = Vector3(1, 1, new_cylinder_length / BASE_CYLINDER_LENGTH)

func set_roller_override_material(material: Material) -> void:
	_ensure_node_references_initialized()
	_left_end_mesh.set_surface_override_material(0, material)
	_right_end_mesh.set_surface_override_material(0, material)
	_cylinder_mesh.set_surface_override_material(0, material)

func _ensure_node_references_initialized() -> void:
	if _left_end_mesh == null:
		_left_end_mesh = get_node_or_null("RollerMeshes/RollerEndL") as MeshInstance3D
	if _right_end_mesh == null:
		_right_end_mesh = get_node_or_null("RollerMeshes/RollerEndR") as MeshInstance3D
	if _cylinder_mesh == null:
		_cylinder_mesh = get_node_or_null("RollerMeshes/RollerLength") as MeshInstance3D
