@tool
class_name FrameRail
extends MeshInstance3D

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var length: float = 1.0:
	set(value):
		if length == value:
			return
		length = value
		_rebuild()

var height: float = 0.5:
	set(value):
		if height == value:
			return
		height = value
		_rebuild()

## When true, the +X edge tracks the conveyor edge on resize.
@export_storage var front_anchored: bool = true

## When true, the -X edge tracks the conveyor edge on resize.
@export_storage var back_anchored: bool = true

@export_storage var front_boundary_tracking: bool = false

@export_storage var back_boundary_tracking: bool = false

## Set false when a bend rail abuts this end (avoids z-fighting).
var cap_front: bool = true:
	set(value):
		if cap_front == value:
			return
		cap_front = value
		_rebuild()

var cap_back: bool = true:
	set(value):
		if cap_back == value:
			return
		cap_back = value
		_rebuild()

static var _shared_material: ShaderMaterial


func _ready() -> void:
	_ensure_shared_material()
	_rebuild()


func _rebuild() -> void:
	if length <= 0 or height <= 0 or not is_inside_tree():
		return
	_ensure_shared_material()
	mesh = ConveyorFrameMesh.create(length, height, cap_front, cap_back)
	set_surface_override_material(0, _shared_material)


func _ensure_shared_material() -> void:
	if _shared_material:
		return
	_shared_material = ConveyorFrameMesh.create_material()
