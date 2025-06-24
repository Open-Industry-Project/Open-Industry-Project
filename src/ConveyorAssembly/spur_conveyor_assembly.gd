@tool
class_name SpurConveyorAssembly
extends ResizableNode3D

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var length: float:
	set(value):
		size.x = value
	get:
		return size.x

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var width: float:
	set(value):
		size.z = value
	get:
		return size.z

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var depth: float:
	set(value):
		size.y = value
	get:
		return size.y

@export_range(-70, 70, 1, "radians_as_degrees") var angle_downstream: float = 0.0:
	set(value):
		if _set_process_if_changed(angle_downstream, value):
			angle_downstream = value

@export_range(-70, 70, 1, "radians_as_degrees") var angle_upstream: float = 0.0:
	set(value):
		if _set_process_if_changed(angle_upstream, value):
			angle_upstream = value

@export_range(1, 20, 1) var conveyor_count: int = 4:
	set(value):
		if _set_process_if_changed(conveyor_count, value):
			conveyor_count = value

@export_storage var conveyor_scene: PackedScene = preload("res://parts/BeltConveyor.tscn"):
	set(value):
		if _set_process_if_changed(conveyor_scene, value):
			conveyor_scene = value
			_add_or_remove_conveyors(0)

var DEFAULT_LENGTH: float = 2.0
var DEFAULT_WIDTH: float = 1.524
var DEFAULT_DEPTH: float = 0.5


func _init() -> void:
	super._init()
	size_default = Vector3(DEFAULT_LENGTH, DEFAULT_DEPTH, DEFAULT_WIDTH)


func _ready() -> void:
	_process(0.0)


func _process(_delta: float) -> void:
	set_process(false)
	_update_conveyors()


func _validate_property(property: Dictionary) -> void:
	var property_name: String = property["name"]
	if property_name in ["length", "width", "depth"]:
		property["usage"] = PROPERTY_USAGE_EDITOR
	if property_name == "size":
		property["usage"] = PROPERTY_USAGE_STORAGE


func _property_can_revert(property: StringName) -> bool:
	if property in ["length", "width", "depth"]:
		return true
	return false


func _property_get_revert(property: StringName) -> Variant:
	match property:
		&"length":
			return DEFAULT_LENGTH
		&"width":
			return DEFAULT_WIDTH
		&"depth":
			return DEFAULT_DEPTH
		_:
			return null


func _get_constrained_size(new_size: Vector3) -> Vector3:
	return new_size


func _update_conveyors() -> void:
	_add_or_remove_conveyors(conveyor_count)
	for i in range(_get_internal_child_count()):
		_update_conveyor(i)


func _add_or_remove_conveyors(count: int) -> void:
	while _get_internal_child_count() > count and _get_internal_child_count() > 0:
		_remove_last_child()
	while _get_internal_child_count() < count and conveyor_scene != null:
		_spawn_conveyor()


func _get_internal_child_count() -> int:
	return get_child_count(true) - get_child_count()


func _remove_last_child() -> void:
	var child := get_child(get_child_count(true) - 1, true)
	remove_child(child)
	child.queue_free()


func _spawn_conveyor() -> void:
	var conveyor := conveyor_scene.instantiate() as Node3D
	add_child(conveyor, false, Node.INTERNAL_MODE_BACK)
	conveyor.owner = null


func _update_conveyor(index: int) -> void:
	var child_3d := get_child(index + get_child_count(), true) as Node3D
	assert(child_3d != null, "SpurConveyorAssembly child is wrong type or missing.")
	child_3d.transform = _get_new_transform_for_conveyor(index)
	if "size" in child_3d:
		child_3d.size = _get_new_size_for_conveyor(index)

	_set_conveyor_properties(child_3d)


func _set_conveyor_properties(_conveyor: Node) -> void:
	pass


func _get_new_transform_for_conveyor(index: int) -> Transform3D:
	var slope_downstream: float = tan(angle_downstream)
	var slope_upstream: float = tan(angle_upstream)

	var conv_width: float = width / conveyor_count
	var conv_half_width: float = 0.5 * conv_width
	var conv_pos_z: float = -0.5 * width + conv_half_width + index * width / conveyor_count
	var ds_contact_z_offset: float = -conv_half_width if angle_downstream > 0 else conv_half_width
	var us_contact_z_offset: float = conv_half_width if angle_upstream > 0 else -conv_half_width
	var ds_displacement_x: float = slope_downstream * (conv_pos_z + ds_contact_z_offset)
	var us_displacement_x: float = slope_upstream * (conv_pos_z + us_contact_z_offset)
	var conv_pos_x: float = (ds_displacement_x + us_displacement_x) / 2.0
	var _conv_length: float = length + ds_displacement_x - us_displacement_x

	var position := Vector3(conv_pos_x, 0, conv_pos_z)
	return Transform3D(Basis.IDENTITY, position)


func _get_new_size_for_conveyor(index: int) -> Vector3:
	var slope_downstream: float = tan(angle_downstream)
	var slope_upstream: float = tan(angle_upstream)

	var conv_width: float = width / conveyor_count
	var conv_half_width: float = 0.5 * conv_width
	var conv_pos_z: float = -0.5 * width + conv_half_width + index * width / conveyor_count
	var ds_contact_z_offset: float = -conv_half_width if angle_downstream > 0 else conv_half_width
	var us_contact_z_offset: float = conv_half_width if angle_upstream > 0 else -conv_half_width
	var ds_displacement_x: float = slope_downstream * (conv_pos_z + ds_contact_z_offset)
	var us_displacement_x: float = slope_upstream * (conv_pos_z + us_contact_z_offset)
	var _conv_pos_x: float = (ds_displacement_x + us_displacement_x) / 2.0
	var conv_length: float = length + ds_displacement_x - us_displacement_x

	var conv_size := Vector3(conv_length, depth, conv_width)
	return conv_size


func _set_process_if_changed(cached_val: Variant, new_val: Variant) -> bool:
	var changed: bool = cached_val != new_val
	if changed:
		set_process(true)
	return changed


func _get_first_conveyor() -> Node:
	if _get_internal_child_count() > 0:
		return get_child(0, true)
	return null


func _on_size_changed() -> void:
	set_process(true)
	super._on_size_changed()
