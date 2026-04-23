@tool
class_name SpurConveyorAssembly
extends ConveyorAttachmentsAssembly

## Length of the spur conveyor assembly in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var length: float:
	set(value):
		size.x = value
	get:
		return size.x

## Width of the spur conveyor assembly in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var width: float:
	set(value):
		size.z = value
	get:
		return size.z

## Height/depth of the spur conveyor assembly in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var depth: float:
	set(value):
		size.y = value
	get:
		return size.y

## Angular offset of the downstream end (positive angles splay outward).
@export_range(-70, 70, 1, "radians_as_degrees") var angle_downstream: float = 0.0:
	set(value):
		if _set_process_if_changed(angle_downstream, value):
			angle_downstream = value

## Angular offset of the upstream end (positive angles splay outward).
@export_range(-70, 70, 1, "radians_as_degrees") var angle_upstream: float = 0.0:
	set(value):
		if _set_process_if_changed(angle_upstream, value):
			angle_upstream = value

## Number of parallel conveyors in the spur assembly.
@export_range(1, 20, 1) var conveyor_count: int = 4:
	set(value):
		if _set_process_if_changed(conveyor_count, value):
			conveyor_count = value

@export_storage var conveyor_scene: PackedScene = preload("res://parts/BeltConveyor.tscn"):
	set(value):
		if _set_process_if_changed(conveyor_scene, value):
			conveyor_scene = value
			_add_or_remove_conveyors(0)

var _conveyors: Array[Node3D] = []

const DEFAULT_LENGTH: float = 2.0
const DEFAULT_WIDTH: float = 1.524
const DEFAULT_DEPTH: float = 0.5


func _init() -> void:
	super._init()
	size_default = Vector3(DEFAULT_LENGTH, DEFAULT_DEPTH, DEFAULT_WIDTH)


func _ready() -> void:
	super._ready()
	_process(0.0)


func _process(_delta: float) -> void:
	set_process(false)
	_update_conveyors()
	_update_frame_rails()


func _validate_property(property: Dictionary) -> void:
	var property_name: String = property["name"]
	if property_name in ["length", "width", "depth"]:
		property["usage"] = PROPERTY_USAGE_EDITOR
	if property_name == "size":
		property["usage"] = PROPERTY_USAGE_STORAGE
	super._validate_property(property)


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
	for i in range(_conveyors.size()):
		_update_conveyor(i)


func _add_or_remove_conveyors(count: int) -> void:
	while _conveyors.size() > count:
		_remove_last_conveyor()
	while _conveyors.size() < count and conveyor_scene != null:
		_spawn_conveyor()


func _get_conveyor_count() -> int:
	return _conveyors.size()


func _remove_last_conveyor() -> void:
	var conveyor := _conveyors.pop_back() as Node3D
	remove_child(conveyor)
	conveyor.queue_free()


func _spawn_conveyor() -> void:
	var conveyor := conveyor_scene.instantiate() as Node3D
	# Tell the child conveyor that the assembly manages its frame.
	if "frame_managed_externally" in conveyor:
		conveyor.frame_managed_externally = true
	add_child(conveyor, false, Node.INTERNAL_MODE_BACK)
	conveyor.owner = null
	_conveyors.append(conveyor)


func _update_conveyor(index: int) -> void:
	var child_3d := _conveyors[index]
	var geometry := _get_conveyor_geometry(index)

	child_3d.transform = Transform3D(Basis.IDENTITY, geometry[0])

	# Set side wall flags before size so they're applied when the mesh rebuilds.
	if "close_left_side" in child_3d:
		child_3d.close_left_side = (index == 0)
	if "close_right_side" in child_3d:
		child_3d.close_right_side = (index == _conveyors.size() - 1)

	if "size" in child_3d:
		child_3d.size = geometry[1]

	_set_conveyor_properties(child_3d)


func _set_conveyor_properties(_conveyor: Node) -> void:
	pass


# Returns `[position, size]` for the child conveyor at the given slot. The
# in-plane center is the midpoint of where each splayed end intersects the
# slot's leading/trailing edge; slot length grows with that splay.
func _get_conveyor_geometry(index: int) -> Array[Vector3]:
	var conv_width: float = width / conveyor_count
	var conv_half_width: float = 0.5 * conv_width
	var conv_pos_z: float = -0.5 * width + conv_half_width + index * conv_width
	var ds_contact_z_offset: float = -conv_half_width if angle_downstream > 0 else conv_half_width
	var us_contact_z_offset: float = conv_half_width if angle_upstream > 0 else -conv_half_width
	var ds_displacement_x: float = tan(angle_downstream) * (conv_pos_z + ds_contact_z_offset)
	var us_displacement_x: float = tan(angle_upstream) * (conv_pos_z + us_contact_z_offset)
	var conv_pos_x: float = (ds_displacement_x + us_displacement_x) / 2.0
	var conv_length: float = length + ds_displacement_x - us_displacement_x

	return [Vector3(conv_pos_x, 0, conv_pos_z), Vector3(conv_length, depth, conv_width)]


func _set_process_if_changed(cached_val: Variant, new_val: Variant) -> bool:
	var changed: bool = cached_val != new_val
	if changed:
		set_process(true)
	return changed


func _get_first_conveyor() -> Node:
	if _conveyors.size() > 0:
		return _conveyors[0]
	return null


func _on_size_changed() -> void:
	set_process(true)
	super._on_size_changed()


func _get_frame_rail_extents(side_z: float) -> Array[float]:
	var slope_ds := tan(angle_downstream)
	var slope_us := tan(angle_upstream)
	var front_x: float = length / 2.0 + slope_ds * side_z
	var back_x: float = -length / 2.0 + slope_us * side_z
	return [back_x, front_x]
