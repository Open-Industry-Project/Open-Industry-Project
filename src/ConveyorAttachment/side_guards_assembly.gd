@tool
class_name SideGuardsAssembly
extends Node3D

enum Side
{
	LEFT = 1,
	RIGHT = 2,
}

@export_subgroup("Right Side Guards", "right_side_guards_")
## If [code]true[/code], automatically generate side guards on the right-hand side of the conveyor.
@export var right_side_guards_enabled: bool = true:
	set(value):
		right_side_guards_enabled = value
		if not is_inside_tree():
			return
		_update_side(Side.RIGHT, right_side_guards_enabled)
## A list of locations on the right-hand side to be kept clear of generated side guards.
@export var right_side_guards_openings: Array[SideGuardOpening]:
	set(value):
		# Unsubscribe from previous openings. They may be replaced with new ones.
		for opening in right_side_guards_openings:
			# Shouldn't be null since all nulls should have been replaced by instances.
			assert(opening != null, "Opening is null.")
			opening.changed.disconnect(_on_opening_changed_right)

		# Workaround for faulty duplicate behavior in the editor.
		# See issue #74918.
		if right_side_guards_openings.size() == 0:
			# Assume that we're initializing for the first time if existing Array is empty.
			for opening in value:
				# Any openings we see in the new Array possibly came from an original that this instance is a duplicate of.
				# There's no way to know for sure.
				# Make all the openings unique to this instance to prevent editing the originals.
				if opening != null:
					opening = opening.duplicate(true)
				right_side_guards_openings.append(opening)
		else:
			# If we're not initializing, avoid making unnecessary duplicates.
			right_side_guards_openings.assign(value)

		# Replace null with a new gap so users don't have to do this by hand.
		for i in range(right_side_guards_openings.size()):
			if right_side_guards_openings[i] == null:
				right_side_guards_openings[i] = SideGuardOpening.new()

		# Subscribe to ensure that side guards update whenever openings change.
		for opening in right_side_guards_openings:
			opening.changed.connect(_on_opening_changed_right)

		# Update side guards to account for added or removed gaps.
		if is_inside_tree():
			_on_opening_changed_right()
@export_subgroup("Left Side Guards", "left_side_guards_")
## If [code]true[/code], automatically generate side guards on the left-hand side of the conveyor.
@export var left_side_guards_enabled: bool = true:
	set(value):
		left_side_guards_enabled = value
		if not is_inside_tree():
			return
		_update_side(Side.LEFT, left_side_guards_enabled)
## A list of locations on the left-hand side to be kept clear of generated side guards.
@export var left_side_guards_openings: Array[SideGuardOpening]:
	set(value):
		# Unsubscribe from previous openings. They may be replaced with new ones.
		for opening in left_side_guards_openings:
			# Shouldn't be null since all nulls should have been replaced by instances.
			assert(opening != null, "Opening is null.")
			opening.changed.disconnect(_on_opening_changed_left)

		# Workaround for faulty duplicate behavior in the editor.
		# See issue #74918.
		if left_side_guards_openings.size() == 0:
			# Assume that we're initializing for the first time if existing Array is empty.
			for opening in value:
				# Any openings we see in the new Array possibly came from an original that this instance is a duplicate of.
				# There's no way to know for sure.
				# Make all the openings unique to this instance to prevent editing the originals.
				if opening != null:
					opening = opening.duplicate(true)
				left_side_guards_openings.append(opening)
		else:
			# If we're not initializing, avoid making unnecessary duplicates.
			left_side_guards_openings.assign(value)

		# Replace null with a new gap so users don't have to do this by hand.
		for i in range(left_side_guards_openings.size()):
			if left_side_guards_openings[i] == null:
				left_side_guards_openings[i] = SideGuardOpening.new()

		# Subscribe to ensure that side guards update whenever openings change.
		for opening in left_side_guards_openings:
			opening.changed.connect(_on_opening_changed_left)

		# Update side guards to account for added or removed gaps.
		if is_inside_tree():
			_on_opening_changed_left()

var _conveyor_connected: bool = false


func _notification(what: int) -> void:
	match what:
		NOTIFICATION_PARENTED:
			_connect_conveyor_signals()
		NOTIFICATION_UNPARENTED:
			_disconnect_conveyor_signals()


func _get_configuration_warnings() -> PackedStringArray:
	if not _conveyor_connected:
		return ["This node must be a child of a Conveyor or ConveyorAssembly."]
	return []


func _connect_conveyor_signals() -> void:
	var conveyor := get_parent()
	if conveyor.has_signal("size_changed") and "size" in conveyor and conveyor.size is Vector3:
		conveyor.size_changed.connect(_on_conveyor_size_changed)
		_conveyor_connected = true
	else:
		_conveyor_connected = false
	update_configuration_warnings()


func _disconnect_conveyor_signals() -> void:
	if not _conveyor_connected:
		return
	_conveyor_connected = false
	var conveyor := get_parent()
	conveyor.size_changed.disconnect(_on_conveyor_size_changed)


func _on_conveyor_size_changed() -> void:
	_update_side_guards()


func _update_side_guards() -> void:
	if not is_inside_tree():
		return
	transform = Transform3D()
	_update_side(Side.LEFT, left_side_guards_enabled)
	_update_side(Side.RIGHT, right_side_guards_enabled)


func _update_side(side: SideGuardsAssembly.Side, side_enabled: bool) -> void:
	if not is_inside_tree():
		return
	if not side_enabled:
		_clear_side(side)
		return
	var side_node: Node3D = _ensure_side(side)
	side_node.transform = _get_side_node_transform(side)

	# Create and arrange side guards
	var side_extents: Array[float] = _get_side_extents(side)
	var side_guard_extents: Array = [side_extents]
	_insert_openings_into_extents(side_guard_extents, side)
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
	var side_node := get_node_or_null(side_name)
	if side_node == null:
		side_node = Node3D.new()
		side_node.name = side_name
		add_child(side_node)
	return side_node


func _get_side_node_transform(side: SideGuardsAssembly.Side) -> Transform3D:
	var conveyor = get_parent()
	var conveyor_width: float = conveyor.size.z
	var offset_z: float = conveyor_width / 2.0
	match side:
		Side.LEFT:
			return Transform3D(Basis.IDENTITY, Vector3(0, 0, -offset_z))
		Side.RIGHT:
			return Transform3D(Basis.IDENTITY, Vector3(0, 0, offset_z))
		_:  # Default case for any unexpected values
			assert(false, "Unknown side: " + str(side))
			return Transform3D()  # Return default transform if assertion doesn't trigger


func _get_side_node_name(side: SideGuardsAssembly.Side) -> StringName:
	match side:
		Side.LEFT:
			return "LeftSide"
		Side.RIGHT:
			return "RightSide"
		_:  # Default case for any unexpected values
			assert(false, "Unknown side: " + str(side))
			return &""  # Return empty StringName if assertion doesn't trigger


func _get_side_extents(side: SideGuardsAssembly.Side) -> Array[float]:
	# Assume side length equal to parent conveyor length dimension.
	# FIXME: This assumption won't be valid for curved conveyors or spur conveyors.
	var conveyor_length: float = get_parent().size.x
	return [-conveyor_length / 2.0, conveyor_length / 2.0]


## Cut gaps into the conveyor extents list.
##
## Shrink or remove conveyor extents to make room for side guard gaps.
##
## @param extent_pairs The list of conveyor extents to cut gaps into.
func _insert_openings_into_extents(extent_pairs: Array, side: SideGuardsAssembly.Side) -> void:
	var side_guards_gaps: Array
	match side:
		Side.RIGHT:
			side_guards_gaps = right_side_guards_openings
		Side.LEFT:
			side_guards_gaps = left_side_guards_openings
	
	var gaps: Array = []
	for gap in side_guards_gaps:
		var extent_front = gap.position - abs(gap.size) / 2.0
		var extent_rear = gap.position + abs(gap.size) / 2.0
		gaps.append([extent_front, extent_rear])

	gaps.sort_custom(func(a, b): return a[0] < b[0])

	var merged_gaps: Array = []
	for gap in gaps:
		if merged_gaps.is_empty():
			merged_gaps.append(gap)
			continue

		var extent_front = gap[0]
		var extent_rear = gap[1]
		var last_gap = merged_gaps[-1]
		var last_extent_front = last_gap[0]
		var last_extent_rear = last_gap[1]

		if last_extent_rear < extent_front:
			merged_gaps.append(gap)
		elif last_extent_rear < extent_rear:
			merged_gaps[-1] = [last_extent_front, extent_rear] as Array[float]

	var i = 0
	while i < extent_pairs.size():
		var extent = extent_pairs[i]
		var extent_front = extent[0]
		var extent_rear = extent[1]

		if extent_rear < extent_front:
			extent_front = extent[1]
			extent_rear = extent[0]
			extent_pairs[i] = [extent_front, extent_rear] as Array[float]

		if extent_front == extent_rear:
			extent_pairs.remove_at(i)
			continue

		for gap in merged_gaps:
			var gap_front = gap[0]
			var gap_rear = gap[1]

			if extent_rear <= gap_front:
				continue

			if extent_front < gap_front and gap_rear < extent_rear:
				extent_pairs.insert(i + 1, [gap_rear, extent_rear])
				extent_pairs[i] = [extent_front, gap_front] as Array[float]
				break

			if gap_front < extent_front and extent_rear < gap_rear:
				extent_pairs.remove_at(i)
				i -= 1
				break

			if extent_front < gap_front and gap_front < extent_rear:
				extent_pairs[i] = [extent_front, gap_front] as Array[float]
				break

			if extent_front < gap_rear and gap_rear < extent_rear:
				extent_pairs[i] = [gap_rear, extent_rear] as Array[float]
				extent = extent_pairs[i]
				extent_front = extent[0]
				extent_rear = extent[1]

		i += 1


#region Adding and removing instances
func _add_or_remove_side_guards(side_node: Node3D, desired_side_guard_count: int) -> void:
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


func _remove_guard(side_node) -> void:
	var guard: Node3D = side_node.get_child(side_node.get_child_count() - 1)
	side_node.remove_child(guard)
	guard.queue_free()


func _instantiate_guard() -> Node3D:
	var guard: Node3D = _get_sideguard_scene().instantiate()
	guard.name = "SideGuard"
	return guard


func _get_sideguard_scene() -> PackedScene:
	return load("res://parts/SideGuard.tscn")


func _adjust_side_guards(side_node: Node3D, side_guard_extents: Array, side: SideGuardsAssembly.Side) -> void:
	const VERTICAL_OFFSET: float = -0.25
	for i in range(side_node.get_child_count()):
		var guard: Node3D = side_node.get_child(i)
		var extent: Array = side_guard_extents[i] as Array[float]
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
		guard.transform = mount_transform * facing_transform * guard_base_transform * length_adjustment

func _on_opening_changed_left() -> void:
	if not is_inside_tree():
		return
	_update_side(Side.LEFT, left_side_guards_enabled)

func _on_opening_changed_right() -> void:
	if not is_inside_tree():
		return
	_update_side(Side.RIGHT, right_side_guards_enabled)


## Called by curved conveyor when inner_radius or conveyor_width changes
func update_for_curved_conveyor(inner_radius: float, conveyor_width: float, conveyor_size: Vector3, conveyor_angle: float) -> void:
	if not is_inside_tree():
		return
	
	# For curved conveyors, we need to adjust the side guard positioning and length calculations
	# The side guard extents need to follow the curved path instead of linear extents
	_update_side_guards_for_curved_conveyor(inner_radius, conveyor_width, conveyor_size, conveyor_angle)


func _update_side_guards_for_curved_conveyor(inner_radius: float, conveyor_width: float, conveyor_size: Vector3, conveyor_angle: float) -> void:
	# Clear and regenerate side guards with curved conveyor geometry
	transform = Transform3D()
	_update_side_for_curved_conveyor(Side.LEFT, left_side_guards_enabled, inner_radius, conveyor_width, conveyor_size, conveyor_angle)
	_update_side_for_curved_conveyor(Side.RIGHT, right_side_guards_enabled, inner_radius, conveyor_width, conveyor_size, conveyor_angle)


func _update_side_for_curved_conveyor(side: SideGuardsAssembly.Side, side_enabled: bool, inner_radius: float, conveyor_width: float, conveyor_size: Vector3, conveyor_angle: float) -> void:
	if not side_enabled:
		_clear_side(side)
		return
		
	var side_node: Node3D = _ensure_side(side)
	side_node.transform = _get_curved_side_node_transform(side, inner_radius, conveyor_width, conveyor_size)

	# Create and arrange side guards for curved path
	var side_extents: Array[float] = _get_curved_side_extents(side, inner_radius, conveyor_width, conveyor_size, conveyor_angle)
	var side_guard_extents: Array = [side_extents]
	_insert_openings_into_extents(side_guard_extents, side)
	_add_or_remove_side_guards(side_node, side_guard_extents.size())
	_adjust_curved_side_guards(side_node, side_guard_extents, side, inner_radius, conveyor_width, conveyor_angle)


func _get_curved_side_node_transform(side: SideGuardsAssembly.Side, inner_radius: float, conveyor_width: float, conveyor_size: Vector3) -> Transform3D:
	# For curved conveyors, position side nodes at the appropriate radius (now using absolute values)
	var radius: float
	match side:
		Side.LEFT:
			# Left side is at inner radius (absolute value)
			radius = inner_radius
			return Transform3D(Basis.IDENTITY, Vector3(0, 0, -radius))
		Side.RIGHT:
			# Right side is at outer radius (absolute value)
			radius = inner_radius + conveyor_width
			return Transform3D(Basis.IDENTITY, Vector3(0, 0, radius))
		_:
			assert(false, "Unknown side: " + str(side))
			return Transform3D()


func _get_curved_side_extents(side: SideGuardsAssembly.Side, inner_radius: float, conveyor_width: float, conveyor_size: Vector3, conveyor_angle: float) -> Array[float]:
	var radius: float
	match side:
		Side.LEFT:
			radius = inner_radius
		Side.RIGHT:
			radius = inner_radius + conveyor_width
		_:
			radius = inner_radius + (conveyor_width * 0.5)
	
	var angle_radians = deg_to_rad(conveyor_angle)
	var arc_length = radius * angle_radians
	
	return [-arc_length / 2.0, arc_length / 2.0]


func _adjust_curved_side_guards(side_node: Node3D, side_guard_extents: Array, side: SideGuardsAssembly.Side, inner_radius: float, conveyor_width: float, conveyor_angle: float) -> void:
	const VERTICAL_OFFSET: float = -0.25
	var angle_radians = deg_to_rad(conveyor_angle)
	
	for i in range(side_node.get_child_count()):
		var guard: Node3D = side_node.get_child(i)
		var extent: Array = side_guard_extents[i] as Array[float]
		var ext_start: float = extent[0]
		var ext_end: float = extent[1]
		var ext_length = ext_end - ext_start
		var ext_middle: float = ext_start + ext_length / 2.0

		# For curved conveyors, position guards along the arc (using absolute values)
		var radius: float
		match side:
			Side.LEFT:
				radius = inner_radius
			Side.RIGHT:
				radius = inner_radius + conveyor_width
			_:
				radius = inner_radius + (conveyor_width * 0.5)
		
		# Convert linear position to angular position along the curve
		var angle_position = ext_middle / radius if radius > 0 else 0
		var mount_point := Vector3(-sin(angle_position) * radius, 0, cos(angle_position) * radius)
		var mount_transform := Transform3D(Basis.IDENTITY, mount_point)
		
		# Rotate the guard to be tangent to the curve
		var tangent_rotation = Transform3D().rotated(Vector3.UP, -angle_position)
		
		# Apply the same base transform adjustments
		var guard_base_transform: Transform3D = Transform3D(Basis.IDENTITY, Vector3(0, 0, 1))
		guard_base_transform.origin.y += VERTICAL_OFFSET
		
		# Face the correct direction for curved conveyor
		var facing_transform := Transform3D()
		match side:
			Side.LEFT:
				facing_transform = Transform3D().rotated(Vector3.UP, PI)
			Side.RIGHT:
				pass
		
		# Scale for length (adjust for curvature)
		var guard_scale_x: float = max(0.01, ext_length - 0.5)
		var length_adjustment := Transform3D().scaled(Vector3(guard_scale_x, 1, 1))
		
		guard.transform = mount_transform * tangent_rotation * facing_transform * guard_base_transform * length_adjustment
