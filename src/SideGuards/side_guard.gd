@tool
class_name SideGuard
extends MeshInstance3D

## Length of the side guard in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var length: float = 1.0:
	set(value):
		length = value
		_rebuild()

## Whether to generate a cap at the front (+X) end.
var cap_front: bool = true:
	set(value):
		cap_front = value
		_rebuild()

## When true, the front (+X) edge tracks the conveyor edge on resize.
## Set to false when the user manually adjusts this edge via gizmo or snapping.
@export_storage var front_anchored: bool = true

## When true, the back (-X) edge tracks the conveyor edge on resize.
@export_storage var back_anchored: bool = true

@export_storage var front_boundary_tracking: bool = false

@export_storage var back_boundary_tracking: bool = false

static var _shared_material: ShaderMaterial
static var suppress_rebuild: bool = false


func _ready() -> void:
	_ensure_shared_material()
	_rebuild()


func _exit_tree() -> void:
	SensorBeamCache.unregister_instance(self)


func _rebuild() -> void:
	if suppress_rebuild or length <= 0 or not is_inside_tree():
		return
	_ensure_shared_material()
	mesh = SideGuardMesh.create(length, cap_front)
	set_surface_override_material(0, _shared_material)
	set_instance_shader_parameter("Scale", 1.0)
	_update_collision_shape()
	SensorBeamCache.register_instance(self)


func _ensure_shared_material() -> void:
	if _shared_material:
		return
	_shared_material = SideGuardMesh.create_material()


func get_metal_material() -> ShaderMaterial:
	return get_surface_override_material(0) as ShaderMaterial


func _update_collision_shape() -> void:
	var collision := get_node_or_null("StaticBody3D/CollisionShape3D") as CollisionShape3D
	if not collision or length <= 0:
		return

	var box := BoxShape3D.new()
	var wh := SideGuardMesh.WALL_HEIGHT
	var wt := SideGuardMesh.WALL_THICKNESS
	# Collision is thicker than the visual mesh to prevent tunneling.
	# Centered on the visual wall so it extends equally inward and outward.
	var ct := SideGuardMesh.COLLISION_THICKNESS
	box.size = Vector3(length, wh, ct)
	collision.shape = box
	collision.position = Vector3(0, wh / 2.0, wt / 2.0)
