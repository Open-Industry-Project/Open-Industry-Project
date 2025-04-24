@tool
class_name SideGuardsAssembly
extends EnhancedNode3D

enum Side
{
	LEFT = 1,
	RIGHT = 2,
}

@export var right_side = true:
	set(value):
		right_side = value
		_update_side(Side.RIGHT, right_side)
@export var left_side = true:
	set(value):
		left_side = value
		_update_side(Side.LEFT, left_side)
var conveyor_connected = false;


func _notification(what: int) -> void:
	match what:
		NOTIFICATION_PARENTED:
			_connect_conveyor_signals()
		NOTIFICATION_UNPARENTED:
			_disconnect_conveyor_signals()
	super._notification(what)


func _connect_conveyor_signals() -> void:
	var conveyor = get_parent()
	if conveyor.has_signal("size_changed") and "size" in conveyor and conveyor.size is Vector3:
		conveyor.connect("size_changed", self._on_conveyor_size_changed)
		conveyor_connected = true
		_on_conveyor_size_changed()
	else:
		conveyor_connected = false
	update_configuration_warnings()


func _disconnect_conveyor_signals() -> void:
	if not conveyor_connected:
		return
	conveyor_connected = false
	var conveyor = get_parent()
	conveyor.disconnect("size_changed", self._on_conveyor_size_changed)


func _get_configuration_warnings() -> PackedStringArray:
	if not conveyor_connected:
		return ["This node must be a child of a Conveyor or ConveyorAssembly."]
	return []


func _on_conveyor_size_changed() -> void:
	_update_side_guards()


func _update_side_guards() -> void:
	transform = Transform3D()
	_update_side(Side.LEFT, left_side)
	_update_side(Side.RIGHT, right_side)


func _update_side(side: SideGuardsAssembly.Side, side_enabled: bool) -> void:
	if not side_enabled:
		_clear_side(side)
		return
	var side_node: Node3D = _ensure_side(side)
	side_node.transform = _get_side_node_transform(side)

	# Create and arrange side guards
	var side_extents: Array[float] = _get_side_extents(side)
	# TODO implement gaps that split the extents into multiple pieces.
	var side_guard_extents: Array = [side_extents]
	_add_or_remove_side_guards(side_node, side_guard_extents.size())
	_adjust_side_guards(side_node, side_guard_extents, side)


func _clear_side(side: SideGuardsAssembly.Side) -> void:
	var side_name: String = _get_side_node_name(side)
	var side_node: Node = get_node_or_null(side_name)
	if side_node != null:
		remove_child(side_node)
		side_node.queue_free()


## Get or create the node for the given side.
func _ensure_side(side: SideGuardsAssembly.Side) -> Node3D:
	var side_name: String = _get_side_node_name(side)
	var side_node = get_node_or_null(side_name)
	if side_node == null:
		side_node = Node3D.new()
		side_node.name = side_name
		add_child(side_node)
		side_node.owner = self
	return side_node


func _get_side_node_transform(side: SideGuardsAssembly.Side):
	var conveyor = get_parent()
	var conveyor_width: float = conveyor.size.z
	var offset_z: float = conveyor_width / 2.0
	match side:
		Side.LEFT:
			return Transform3D(Basis.IDENTITY, Vector3(0, 0, -offset_z))
		Side.RIGHT:
			return Transform3D(Basis.IDENTITY, Vector3(0, 0, offset_z))
	assert(false, "Unknown side: " + str(side))


func _get_side_node_name(side: SideGuardsAssembly.Side):
	match side:
		Side.LEFT:
			return "LeftSide"
		Side.RIGHT:
			return "RightSide"


func _get_side_extents(side: SideGuardsAssembly.Side) -> Array[float]:
	# Assume side length equal to parent conveyor length dimension.
	# FIXME: This assumption won't be valid for curved conveyors or spur conveyors.
	var conveyor_length: float = get_parent().size.x
	return [-conveyor_length / 2.0, conveyor_length / 2.0]


func _add_or_remove_side_guards(side_node: Node3D, desired_side_guard_count: int) -> void:
	# Add or remove guards
	# Assume all children are guards.
	var guard_count: int = side_node.get_child_count()
	while guard_count < desired_side_guard_count:
		_add_guard(side_node)
		guard_count += 1
	while guard_count > desired_side_guard_count:
		_remove_guard(side_node)
		guard_count -= 1


func _add_guard(side_node: Node) -> void:
	var guard: Node3D = _instantiate_guard()
	side_node.add_child(guard)
	guard.owner = self


func _remove_guard(side_node) -> void:
	var guard: Node3D = side_node.get_child(side_node.get_child_count() - 1)
	side_node.remove_child(guard)
	guard.queue_free()


func _instantiate_guard() -> Node3D:
	var guard: Node3D = _get_sideguard_scene().instantiate()
	guard.name = "SideGuard"
	return guard


func _get_sideguard_scene() -> PackedScene:
	# TODO: Account for differences between conveyors/side guard types.
	return load("res://parts/SideGuard.tscn")


func _adjust_side_guards(side_node: Node3D, side_guard_extents: Array, side: SideGuardsAssembly.Side) -> void:
	const VERTICAL_OFFSET: float = -0.25
	for i in range(side_node.get_child_count()):
		var guard: Node3D = side_node.get_child(i)
		var extent: Array[float] = side_guard_extents[i]
		var ext_start: float = extent[0]
		var ext_end: float = extent[1]
		var ext_length = ext_end - ext_start
		var ext_middle: float = ext_start + ext_length / 2.0

		var mount_point := Vector3(ext_middle, 0, 0)
		var mount_transform := Transform3D(Basis.IDENTITY, mount_point)
		# SideGuards aren't centered at the origin. This transform accounts for that by centering them on it.
		var guard_base_transform: Transform3D = Transform3D(Basis.IDENTITY, Vector3(0, 0, 1))
		# SideGuards are also slightly offset vertically. Adjust accoringly.
		guard_base_transform.origin.y += VERTICAL_OFFSET
		# Face the correct direction depending on the current side.
		var facing_transform := Transform3D()
		match side:
			Side.LEFT:
				pass
			Side.RIGHT:
				facing_transform = Transform3D().rotated(Vector3.UP, PI)
		# Set length via scaling.
		# Account for the ends extending beyond the guard.
		# TODO use a `length` property for side guards instead of `scale.x`.
		var guard_scale_x: float = max(0.01, ext_length - 0.5)
		var length_adjustment := Transform3D().scaled(Vector3(guard_scale_x, 1, 1))
		# Apply all transforms.
		guard.transform = mount_transform * facing_transform * guard_base_transform * length_adjustment
