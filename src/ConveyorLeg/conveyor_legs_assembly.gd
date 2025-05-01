@tool
class_name ConveyorLegsAssembly
extends Node3D

# Workarounds for renaming class
var assembly: EnhancedNode3D:
	get:
		return get_parent()

var conveyor: ResizableNode3D:
	get:
		return get_parent()

var apparent_transform: Transform3D:
	get:
		return transform
	set(value):
		transform = value

# Region Leg Stands
# Region Constants
const LEG_STANDS_BASE_WIDTH = 2.0
const AUTO_LEG_STAND_NAME_PREFIX = "ConveyorLegMiddle"
const AUTO_LEG_STAND_NAME_FRONT = "ConveyorLegHead"
const AUTO_LEG_STAND_NAME_REAR = "ConveyorLegTail"
const MIDDLE_LEGS_SPACING_MIN: float = 0.5
const DEFAULT_FLOOR_PLANE := Plane(Vector3.UP, 0.0)

enum LegIndex {
	FRONT = -1,
	REAR = -2,
	NON_AUTO = -3,
}

## A global plane that represents the floor for the legs.
##
## A plane is defined by a normal vector and a distance from the origin.
## Legs will reach down from their conveyor to this plane, and they will be aligned to the normal vector when possible.
## However, they prioritize being aligned to the conveyor.
@export_custom(PROPERTY_HINT_NONE, "suffix:m")
var floor_plane: Plane = DEFAULT_FLOOR_PLANE:
	set(value):
		global_floor_plane = value
	get:
		return global_floor_plane
## A global plane that represents the floor for the legs.
##
## A plane is defined by a normal vector and a distance from the origin.
## Legs will reach down from their conveyor to this plane, and they will be aligned to the normal vector when possible.
## However, they prioritize being aligned to the conveyor.
var global_floor_plane: Plane = DEFAULT_FLOOR_PLANE:
	set(value):
		assert(value.normal != Vector3.ZERO, "global_floor_plane: normal cannot be zero.")
		global_floor_plane = value.normalized()
		_update_floor_plane()
## The plane that represents the floor for the legs in the conveyor's space.
##
## A plane is defined by a normal vector and a distance from the origin.
## Legs will reach down from their conveyor to this plane in the direction of the normal vector.
##
## This plane is derived from `global_floor_plane` and the conveyor's transform.
## It's used as a backup when the node is outside the tree and global calculations aren't possible.
## It's directly connected to the ConveyorLegsAssembly's `transform` property, which is always on this plane and aligned with it.
## Its normal is aligned to the conveyor and its legs, so it may not correspond to `global_floor_plane` if the conveyor has rotated on its X-axis.
@export_storage
var local_floor_plane: Plane = DEFAULT_FLOOR_PLANE:
	get = get_local_floor_plane, set = set_local_floor_plane


@export_group("Middle Legs", "middle_legs")
@export
var middle_legs_enabled := false:
	set(value):
		if middle_legs_enabled != value:
			middle_legs_enabled = value
			set_needs_update(true)
@export_range(-5, 5, 0.01, "or_less", "or_greater", "suffix:m")
var middle_legs_initial_leg_position: float:
	get = get_middle_legs_initial_leg_position, set = set_middle_legs_initial_leg_position
@export_range(MIDDLE_LEGS_SPACING_MIN, 5, 0.01, "or_greater", "suffix:m")
var middle_legs_spacing: float = 2:
	set(value):
		if middle_legs_spacing != value:
			middle_legs_spacing = value
			set_needs_update(true)


@export_group("Head End", "head_end")
@export_range(0, 1, 0.01, "or_greater", "suffix:m")
var head_end_attachment_offset: float = 0.45:
	set(value):
		if head_end_attachment_offset != value:
			head_end_attachment_offset = value
			update_leg_stand_coverage()
@export
var head_end_leg_enabled: bool = true:
	set(value):
		if head_end_leg_enabled != value:
			head_end_leg_enabled = value
			set_needs_update(true)
@export_range(0.5, 5, 0.01, "or_greater", "suffix:m")
var head_end_leg_clearance: float = 0.5:
	set(value):
		if head_end_leg_clearance != value:
			head_end_leg_clearance = value
			set_needs_update(true)


@export_group("Tail End", "tail_end")
@export_range(0, 1, 0.01, "or_greater", "suffix:m")
var tail_end_attachment_offset: float = 0.45:
	set(value):
		if tail_end_attachment_offset != value:
			tail_end_attachment_offset = value
			update_leg_stand_coverage()
@export
var tail_end_leg_enabled: bool = true:
	set(value):
		if tail_end_leg_enabled != value:
			tail_end_leg_enabled = value
			set_needs_update(true)
@export_range(0.5, 5, 0.01, "or_greater", "suffix:m")
var tail_end_leg_clearance: float = 0.5:
	set(value):
		if tail_end_leg_clearance != value:
			tail_end_leg_clearance = value
			set_needs_update(true)


@export_group("Model", "leg_model")
@export
var leg_model_scene: PackedScene = preload("res://parts/ConveyorLegBC.tscn"):
	set(value):
		if leg_model_scene != value:
			leg_model_scene = value
			update_leg_stands_height_and_visibility()
			update_leg_stand_coverage()
@export
var leg_model_grabs_offset: float = 0.132:
	set(value):
		if leg_model_grabs_offset != value:
			leg_model_grabs_offset = value
			update_leg_stands_height_and_visibility()
			update_leg_stand_coverage()


# Configuration change detection fields
var assembly_transform_prev := Transform3D.IDENTITY
var conveyors_transform_prev := Transform3D.IDENTITY
var leg_stands_transform_prev := Transform3D.IDENTITY
var target_width_prev := NAN
var conveyor_angle_prev := 0.0
var middle_legs_enabled_prev := false
var middle_legs_spacing_prev: float
var head_end_leg_enabled_prev := false
var tail_end_leg_enabled_prev := false
var head_end_leg_clearance_prev := 0.5
var tail_end_leg_clearance_prev := 0.5
var leg_model_scene_prev: PackedScene

var leg_stands_path_changed := true

# Fields / Leg stand coverage
var leg_stand_coverage_min: float
var leg_stand_coverage_max: float
var leg_stand_coverage_min_prev: float
var leg_stand_coverage_max_prev: float
var leg_stands_coverage_changed := false

# Dictionary to store pre-existing leg stand owners
var foreign_leg_stands_owners := {}

var conveyor_connected: bool = false

func _init():
	set_notify_transform(true)

func _ready():
	var edited_scene = get_tree().get_edited_scene_root()
	for leg_stand in get_children():
		if leg_stand.owner != edited_scene:
			foreign_leg_stands_owners[leg_stand.name] = leg_stand.owner

#region Managing connection to Conveyor's signals
func _notification(what):
	if what == NOTIFICATION_PARENTED:
		assembly_transform_prev = get_parent().transform
		_connect_conveyor_signals()
	elif what == NOTIFICATION_UNPARENTED:
		_disconnect_conveyor_signals()
	elif what == NOTIFICATION_TRANSFORM_CHANGED:
		_on_global_transform_changed()
	elif what == NOTIFICATION_ENTER_TREE:
		_on_global_transform_changed()

func _on_global_transform_changed():
	_update_floor_plane()
	update_leg_stand_coverage()
	update_leg_stands_height_and_visibility()

func _connect_conveyor_signals() -> void:
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
	conveyor.disconnect("size_changed", self._on_conveyor_size_changed)

func _get_configuration_warnings() -> PackedStringArray:
	if not conveyor_connected:
		return ["This node must be a child of a Conveyor or ConveyorAssembly."]
	return []
#endregion

func _on_conveyor_size_changed():
	update_leg_stand_coverage()
	update_leg_stands_height_and_visibility()

func _physics_process(_delta):
	update_leg_stands()
	set_needs_update(false)

func set_needs_update(value: bool):
	set_physics_process(value)

func get_local_floor_plane() -> Plane:
	var floor_normal: Vector3 = transform.basis.y.normalized()
	var floor_offset = transform.origin.dot(floor_normal)
	return Plane(floor_normal, floor_offset)

func set_local_floor_plane(value: Plane):
	var old_value = get_local_floor_plane()
	var normal_changed = old_value.normal != value.normal
	var distance_changed = old_value.d != value.d
	_save_local_floor_plane_to_transform(value)
	if normal_changed:
		update_leg_stand_coverage()
	if normal_changed or distance_changed:
		update_leg_stands_height_and_visibility()

func _save_local_floor_plane_to_transform(new_local_floor_plane: Plane):
	_save_properties_to_local_transform(new_local_floor_plane, middle_legs_initial_leg_position)

func _save_properties_to_local_transform(new_local_floor_plane: Plane, new_middle_legs_initial_leg_position: float):
	var floor_offset = new_local_floor_plane.d
	var floor_normal = new_local_floor_plane.normal

	var offset_x = new_middle_legs_initial_leg_position
	var offset_y = floor_offset
	var normal_y = floor_normal
	var normal_z = apparent_transform.basis.z.normalized()
	var normal_x = normal_y.cross(normal_z).normalized()
	var origin = normal_x * offset_x + normal_y * offset_y
	apparent_transform = Transform3D(normal_x, normal_y, normal_z, origin)

func get_middle_legs_initial_leg_position() -> float:
	var normal_x = apparent_transform.basis.x.normalized()
	return apparent_transform.origin.dot(normal_x)

func set_middle_legs_initial_leg_position(value: float):
	if (value == get_middle_legs_initial_leg_position()):
		return
	_save_middle_legs_initial_leg_position_to_transform(value)
	update_leg_stand_coverage()

func _save_middle_legs_initial_leg_position_to_transform(new_middle_legs_initial_leg_position: float):
	_save_properties_to_local_transform(local_floor_plane, new_middle_legs_initial_leg_position)

func update_leg_stand_coverage():
	var coverage = get_leg_stand_coverage()
	leg_stand_coverage_min = coverage[0]
	leg_stand_coverage_max = coverage[1]
	leg_stands_coverage_changed = leg_stand_coverage_min != leg_stand_coverage_min_prev \
								or leg_stand_coverage_max != leg_stand_coverage_max_prev
	if leg_stands_coverage_changed:
		set_needs_update(true)

func get_leg_stand_coverage() -> Array[float]:
	if not conveyor:
		return [0.0, 0.0]

	var min_val := INF
	var max_val := -INF

	# Conveyor's Transform in the legStands space
	var local_conveyor_transform := transform.affine_inverse()

	# Extent and offset positions in unscaled conveyor space
	var conveyor_extent_front := Vector3(-absf(conveyor.size.x * 0.5), 0.0, 0.0)
	var conveyor_extent_rear := Vector3(absf(conveyor.size.x * 0.5), 0.0, 0.0)

	var margin_offset_front := Vector3(head_end_attachment_offset, 0.0, 0.0)
	var margin_offset_rear := Vector3(-tail_end_attachment_offset, 0.0, 0.0)

	# The tip of the leg stand has a rotating grab model that isn't counted towards its height.
	# Because the grab will rotate towards the conveyor, we account for its reach here.
	# Grab the bottom of the conveyor.
	var conveyor_depth = conveyor.size.y
	var grab_offset := Vector3(0.0, -leg_model_grabs_offset - conveyor_depth, 0.0)

	# Final grab points in legStands space
	var leg_grab_point_front := local_conveyor_transform.orthonormalized() * (conveyor_extent_front + margin_offset_front + grab_offset)
	var leg_grab_point_rear := local_conveyor_transform.orthonormalized() * (conveyor_extent_rear + margin_offset_rear + grab_offset)

	# Update min and max
	min_val = minf(min_val, minf(leg_grab_point_rear.x, leg_grab_point_front.x))
	max_val = maxf(max_val, maxf(leg_grab_point_rear.x, leg_grab_point_front.x))

	return [min_val, max_val]

func _update_floor_plane():
	if not is_inside_tree():
		return
	# Legs must be constrained to the conveyor's Z plane, so we must project the floor normal onto it.
	var legs_plane := Plane(conveyor.global_basis.z, conveyor.global_position)
	assert(legs_plane.normal != Vector3.ZERO, "ConveyorLegsAssembly: conveyor's global Z basis vector must not be zero")
	assert(global_floor_plane.normal != Vector3.ZERO, "ConveyorLegsAssembly: global_floor_plane normal is zero")
	var adjusted_global_floor_plane_normal: Vector3 = global_floor_plane.normal.slide(legs_plane.normal).normalized()
	assert(adjusted_global_floor_plane_normal != Vector3.ZERO, "ConveyorLegsAssembly: Legs and floor plane can't be parallel; the legs would never reach the floor.")
	var adjusted_global_floor_plane_point = global_floor_plane.intersects_ray(conveyor.global_position, -adjusted_global_floor_plane_normal)
	if adjusted_global_floor_plane_point == null:
		adjusted_global_floor_plane_point = global_floor_plane.intersects_ray(conveyor.global_position, adjusted_global_floor_plane_normal)
	assert(adjusted_global_floor_plane_point != null, "ConveyorLegsAssembly: adjusted_global_floor_plane_point is null")
	var adjusted_global_floor_plane := Plane(adjusted_global_floor_plane_normal, adjusted_global_floor_plane_point)

	# Prevent infinite loop.
	set_notify_transform(false)
	set_local_floor_plane(conveyor.global_transform.affine_inverse() * adjusted_global_floor_plane)
	set_notify_transform(true)

func update_leg_stands():
	# If the leg stand scene changes, we need to regenerate everything
	if leg_model_scene != leg_model_scene_prev:
		delete_all_auto_leg_stands()

	# Only bother repositioning leg stands if the user could manually edit them
	# All the leg stands that we generated should already be in the right spots
	var edited_root = get_tree().get_edited_scene_root()
	var leg_stands_is_editable = edited_root != null and (edited_root == owner or edited_root.is_editable_instance(owner))
	if leg_stands_is_editable or leg_stands_path_changed:
		snap_all_leg_stands_to_path()

	leg_stands_path_changed = false

	var target_width_new = get_leg_stand_target_width()
	var target_width_changed = target_width_prev != target_width_new
	target_width_prev = target_width_new
	if leg_stands_is_editable or target_width_changed:
		update_all_leg_stands_width()

	var debug_invariants := true
	var leg_stand_coverage_min_value_for_assertion: float = 0.0
	var leg_stand_coverage_max_value_for_assertion: float = 0.0
	if debug_invariants:
		leg_stand_coverage_min_value_for_assertion = leg_stand_coverage_min
		leg_stand_coverage_max_value_for_assertion = leg_stand_coverage_max

	var auto_leg_stands_update_is_needed: bool = middle_legs_enabled != middle_legs_enabled_prev \
		or middle_legs_spacing != middle_legs_spacing_prev \
		or head_end_leg_enabled != head_end_leg_enabled_prev \
		or tail_end_leg_enabled != tail_end_leg_enabled_prev \
		or head_end_leg_clearance != head_end_leg_clearance_prev \
		or tail_end_leg_clearance != tail_end_leg_clearance_prev \
		or leg_model_scene != leg_model_scene_prev \
		or leg_stands_coverage_changed

	var number_of_leg_stands_adjusted: int = 0
	var did_add_or_remove := false
	if auto_leg_stands_update_is_needed:
		number_of_leg_stands_adjusted = adjust_auto_leg_stand_positions()
		did_add_or_remove = create_and_remove_auto_leg_stands()

	# Dependencies
	var leg_stands_children_changed = number_of_leg_stands_adjusted != 0 or did_add_or_remove
	# Actually, it's the relative transform of LegStands and Conveyors that we need to monitor,
	# specifically the conveyor_plane in update_leg_stands_height_and_visibility,
	# but the individual Transforms are good enough for now, though overkill
	var conveyor_transform_changed = conveyor.transform != conveyors_transform_prev
	var leg_stands_transform_changed = transform != leg_stands_transform_prev
	if leg_stands_children_changed or conveyor_transform_changed or leg_stands_transform_changed or leg_stands_coverage_changed:
		update_leg_stands_height_and_visibility()

	# Record external state to detect any changes next run
	conveyors_transform_prev = conveyor.transform
	leg_stands_transform_prev = transform
	middle_legs_enabled_prev = middle_legs_enabled
	head_end_leg_enabled_prev = head_end_leg_enabled
	tail_end_leg_enabled_prev = tail_end_leg_enabled
	head_end_leg_clearance_prev = head_end_leg_clearance
	tail_end_leg_clearance_prev = tail_end_leg_clearance
	leg_model_scene_prev = leg_model_scene
	leg_stand_coverage_min_prev = leg_stand_coverage_min
	leg_stand_coverage_max_prev = leg_stand_coverage_max

	if debug_invariants:
		assert(leg_stand_coverage_min == leg_stand_coverage_min_value_for_assertion, "Unexpected change detected: leg_stand_coverage_min")
		assert(leg_stand_coverage_max == leg_stand_coverage_max_value_for_assertion, "Unexpected change detected: leg_stand_coverage_max")

func delete_all_auto_leg_stands():
	for child in get_children():
		if is_auto_leg_stand(child):
			remove_child(child)
			child.queue_free()

func is_auto_leg_stand(node: Node) -> bool:
	return get_auto_leg_stand_index(node.name) != LegIndex.NON_AUTO


func snap_all_leg_stands_to_path() -> void:
	# Force legStand alignment with LegStands group
	for child in get_children():
		if not child is ConveyorLeg:
			continue
		snap_to_leg_stands_path(child)

func update_all_leg_stands_width() -> void:
	for child in get_children():
		if not child is ConveyorLeg:
			continue
		update_leg_stand_width(child)

func update_leg_stand_width(leg_stand: Node3D) -> void:
	var target_width := get_leg_stand_target_width()
	leg_stand.scale = Vector3(1.0, leg_stand.scale.y, target_width / LEG_STANDS_BASE_WIDTH)

func get_leg_stand_target_width() -> float:
	# This is a hack to account for the fact that CurvedRollerConveyors are slightly wider than other conveyors
	var conveyor_width: float = conveyor.size.z
	# TODO: Restore RollerConveyor code.
	#if conveyor is CurvedRollerConveyor:
	#	return conveyor_width * 1.055
	#if conveyor is RollerConveyor:
	#	return conveyor_width + 0.051 * 2.0
	return conveyor_width

## Snap a child leg stand to a position on the leg stands path.
##
## The leg stands path is a surface parallel to `leg_stands` Y axis.
## It represents any position that the conveyor line would be directly above or below at some length.
## For straight assemblies, this is `leg_stands` XY plane.
## For curved assemblies, this is overridden to be a cylinder centered on `leg_stands`.
func snap_to_leg_stands_path(leg_stand: Node3D) -> void:
	move_leg_stand_to_path_position(leg_stand, get_position_on_leg_stands_path(leg_stand.position))

## Get the path position of a point projected onto the leg stands path.
##
## The path position is a linear representation of where a point is on the leg stands path.
## For straight assemblies, this is the X coordinate of the point.
## For curved assemblies, this is an angle of the point around the leg stands Y axis in degrees.
func get_position_on_leg_stands_path(position: Vector3) -> float:
	return position.x

## Move a leg stand to a given position on the leg stands path.
##
## The leg stand is moved and rotated to align with the path.
## The leg stand keeps its Y position and Z rotation.
## Curved assemblies override this and don't keep the Z rotation.
func move_leg_stand_to_path_position(leg_stand: Node3D, path_position: float) -> bool:
	var changed := false
	var new_position := Vector3(path_position, leg_stand.position.y, 0.0)
	if leg_stand.position != new_position:
		leg_stand.position = new_position
		changed = true

	var new_rotation := Vector3(0.0, 0.0, leg_stand.rotation.z)
	if leg_stand.rotation != new_rotation:
		leg_stand.rotation = new_rotation
		changed = true

	return changed

## Adjust the positions of all auto-instanced leg stands to match changed settings or coverage.
func adjust_auto_leg_stand_positions() -> int:
	# Don't allow tiny or negative intervals
	middle_legs_spacing = maxf(MIDDLE_LEGS_SPACING_MIN, middle_legs_spacing)
	if middle_legs_spacing == middle_legs_spacing_prev and \
	   leg_stand_coverage_max == leg_stand_coverage_max_prev and \
	   leg_stand_coverage_min == leg_stand_coverage_min_prev:
		return 0

	var change_count := 0
	for child in get_children():
		if not child is ConveyorLeg:
			continue

		var leg_stand_index := get_auto_leg_stand_index(child.name)
		match leg_stand_index:
			LegIndex.NON_AUTO:
				# Only adjust auto leg stands
				pass
			_:
				# Update leg stand position to the new interval
				if move_leg_stand_to_path_position(child, get_auto_leg_stand_position(leg_stand_index)):
					change_count += 1

	middle_legs_spacing_prev = middle_legs_spacing
	return change_count


func get_auto_leg_stand_index(name: StringName) -> int:
	if name == AUTO_LEG_STAND_NAME_FRONT:
		return LegIndex.FRONT
	if name == AUTO_LEG_STAND_NAME_REAR:
		return LegIndex.REAR
	if name.begins_with(AUTO_LEG_STAND_NAME_PREFIX):
		var index_str = name.substr(AUTO_LEG_STAND_NAME_PREFIX.length())
		if index_str.is_valid_int():
			# Names start at 1, but indices start at 0
			return index_str.to_int() - 1
	return LegIndex.NON_AUTO

func get_auto_leg_stand_position(index: int) -> float:
	if index == LegIndex.FRONT:
		return leg_stand_coverage_min
	if index == LegIndex.REAR:
		return leg_stand_coverage_max
	return get_interval_leg_stand_position(index)

func get_interval_leg_stand_position(index: int) -> float:
	assert(index >= 0)
	# Don't allow negative clearance
	head_end_leg_clearance = maxf(0.0, head_end_leg_clearance)
	var front_margin = head_end_leg_clearance if head_end_leg_enabled else 0.0
	var first_position = ceili((leg_stand_coverage_min + front_margin) / middle_legs_spacing) * middle_legs_spacing
	return first_position + index * middle_legs_spacing



func create_and_remove_auto_leg_stands() -> bool:
	var changed := false
	# Don't allow negative clearance
	tail_end_leg_clearance = maxf(0.0, tail_end_leg_clearance)
	# Enforce a margin from fixed front and rear legs if they exist
	var first_position := get_interval_leg_stand_position(0)
	var rear_margin: float = tail_end_leg_clearance if tail_end_leg_enabled else 0.0
	var last_position: float = floorf((leg_stand_coverage_max - rear_margin) / middle_legs_spacing) * middle_legs_spacing

	var interval_leg_stand_count: int
	if not middle_legs_enabled:
		interval_leg_stand_count = 0
	elif first_position > last_position:
		# Invalid range implies zero interval-aligned leg stands are needed
		interval_leg_stand_count = 0
	else:
		interval_leg_stand_count = int((last_position - first_position) / middle_legs_spacing) + 1

	# Inventory our existing leg stands and delete the ones we don't need
	var has_front_leg := false
	var has_rear_leg := false
	var leg_stands_inventory: Array[bool] = []
	leg_stands_inventory.resize(interval_leg_stand_count)
	leg_stands_inventory.fill(false)

	for child in get_children():
		if not child is ConveyorLeg:
			continue

		var leg_stand_index := get_auto_leg_stand_index(child.name)
		match leg_stand_index:
			LegIndex.NON_AUTO:
				# Only manage auto leg stands
				pass
			LegIndex.FRONT:
				if head_end_leg_enabled:
					has_front_leg = true
				else:
					remove_child(child)
					child.queue_free()
			LegIndex.REAR:
				if tail_end_leg_enabled:
					has_rear_leg = true
				else:
					remove_child(child)
					child.queue_free()
			_:
				# Mark existing leg stands that are in the new interval
				if leg_stand_index < interval_leg_stand_count and middle_legs_enabled:
					leg_stands_inventory[leg_stand_index] = true
				else:
					# Delete leg stands that are outside the new interval
					remove_child(child)
					child.queue_free()
					changed = true

	# Create the missing leg stands
	if leg_model_scene == null:
		return changed

	if not has_front_leg and head_end_leg_enabled:
		add_leg_stand_at_index(LegIndex.FRONT)
		changed = true

	for i in interval_leg_stand_count:
		if not leg_stands_inventory[i]:
			add_leg_stand_at_index(i)
			changed = true

	if not has_rear_leg and tail_end_leg_enabled:
		add_leg_stand_at_index(LegIndex.REAR)
		changed = true

	return changed

func add_leg_stand_at_index(index: int) -> ConveyorLeg:
	var position: float = get_auto_leg_stand_position(index)
	var name: StringName

	match index:
		LegIndex.FRONT:
			name = &"ConveyorLegHead"
		LegIndex.REAR:
			name = &"ConveyorLegTail"
		_:
			# Indices start at 0, but names start at 1
			name = &"ConveyorLegMiddle%d" % (index + 1)

	var leg_stand := add_or_get_leg_stand_instance(name) as ConveyorLeg
	move_leg_stand_to_path_position(leg_stand, position)
	update_leg_stand_width(leg_stand)

	# It probably doesn't matter, but let's try to keep leg stands in order
	var true_index: int
	match index:
		LegIndex.FRONT:
			true_index = 0
		LegIndex.REAR:
			true_index = -1
		_:
			true_index = index + 1 if head_end_leg_enabled else index

	if true_index < get_child_count():
		move_child(leg_stand, true_index)

	return leg_stand

func add_or_get_leg_stand_instance(name: StringName) -> Node:
	var leg_stand := get_node_or_null(NodePath(name))
	if leg_stand != null:
		return leg_stand

	leg_stand = leg_model_scene.instantiate()
	leg_stand.name = name
	add_child(leg_stand)
	# If the leg stand used to exist, restore its original owner
	leg_stand.owner = foreign_leg_stands_owners.get(name, get_tree().get_edited_scene_root())
	return leg_stand


func update_leg_stands_height_and_visibility():
	if not conveyor:
		return

	# Plane transformed from conveyors space into legStands space
	var conveyor_plane = Plane(Vector3.UP, Vector3(0, -leg_model_grabs_offset - conveyor.size.y, 0)) \
		* transform

	for child in get_children():
		var leg_stand = child as ConveyorLeg
		if leg_stand:
			update_individual_leg_stand_height_and_visibility(leg_stand, conveyor_plane)

func update_individual_leg_stand_height_and_visibility(leg_stand: ConveyorLeg, conveyor_plane: Plane):
	# Raycast from the minimum-height tip of the leg stand to the conveyor plane
	var intersection = conveyor_plane.intersects_ray(
		leg_stand.position + leg_stand.basis.y.normalized(),
		leg_stand.basis.y.normalized()
	)

	if not intersection:
		leg_stand.visible = false
		# Set scale to minimum height
		leg_stand.scale = Vector3(1.0, 1.0, leg_stand.scale.z)
		return

	var leg_height = intersection.distance_to(leg_stand.position)
	leg_stand.scale = Vector3(1.0, leg_height, leg_stand.scale.z)
	leg_stand.grabs_rotation = rad_to_deg(leg_stand.basis.y.signed_angle_to(
		conveyor_plane.normal.slide(leg_stand.basis.z.normalized()),
		leg_stand.basis.z
	))

	# Only show leg stands that touch a conveyor
	var tip_position = get_position_on_leg_stands_path(leg_stand.position + leg_stand.basis.y)
	leg_stand.visible = leg_stand_coverage_min <= tip_position and tip_position <= leg_stand_coverage_max
