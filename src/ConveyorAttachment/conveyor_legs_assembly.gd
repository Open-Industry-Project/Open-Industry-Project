@tool
class_name ConveyorLegsAssembly
extends Node3D

enum LegIndex {
	FRONT = -1,
	REAR = -2,
	NON_AUTO = -3,
}

const CONVEYOR_LEGS_BASE_WIDTH = 2.0
const AUTO_CONVEYOR_LEG_NAME_PREFIX_MIDDLE = "ConveyorLegMiddle"
const AUTO_CONVEYOR_LEG_NAME_FRONT = "ConveyorLegTail"
const AUTO_CONVEYOR_LEG_NAME_REAR = "ConveyorLegHead"
const MIDDLE_LEGS_SPACING_MIN: float = 0.5
const DEFAULT_FLOOR_PLANE := Plane(Vector3.UP, -2.0)

## A global plane that represents the floor for the legs.
##
## A plane is defined by a normal vector and a distance from the origin.
## Legs will reach down from their conveyor to this plane, and they will be aligned to the normal vector when possible.
## However, they prioritize being aligned to the conveyor.
@export_custom(PROPERTY_HINT_NONE, "suffix:m")
var floor_plane: Plane = DEFAULT_FLOOR_PLANE:
	set(value):
		floor_plane = value
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
## This plane is derived from [member global_floor_plane] and the conveyor's [member Node3D.transform].
## It's used as a backup when the node is outside the tree and global calculations aren't possible.
## It's directly connected to the ConveyorLegsAssembly's [member transform] property, which is always on this plane and aligned with it.
## Its normal is aligned to the conveyor and its legs, so it may not correspond to [member global_floor_plane] if the conveyor has rotated on its X-axis.
@export_storage
var local_floor_plane: Plane = DEFAULT_FLOOR_PLANE:
	get = get_local_floor_plane, set = set_local_floor_plane


@export_group("Middle Legs", "middle_legs")
## If [code]true[/code], automatically generate conveyor legs under the conveyor spaced at a given interval.
@export
var middle_legs_enabled := false:
	set(value):
		if middle_legs_enabled != value:
			middle_legs_enabled = value
			_set_needs_update(true)
## The linear position of the first generated leg along the conveyor's path.
##
## Other generated legs are positioned relative to this one.
@export_range(-5, 5, 0.01, "or_less", "or_greater", "suffix:m")
var middle_legs_initial_leg_position: float:
	get = get_middle_legs_initial_leg_position, set = set_middle_legs_initial_leg_position
## The distance in meters between each generated middle leg.[br][br]
##
## See also: [member head_end_leg_clearance] and [member tail_end_leg_clearance] for minimum distances from the end legs.
@export_range(MIDDLE_LEGS_SPACING_MIN, 5, 0.01, "or_greater", "suffix:m")
var middle_legs_spacing: float = 2:
	set(value):
		if middle_legs_spacing != value:
			middle_legs_spacing = value
			_set_needs_update(true)

## The number of middle leg instances.
##
## Setting this creates or removes legs. Getting it returns the current number of legs.
##
## Addresses "Child node disappeared while duplicating" issue.
@export_storage()
var _middle_legs_instance_count: int = 0:
	set(value):
		_middle_legs_instance_count = value
		_create_and_remove_auto_conveyor_legs(value)
	get:
		# Count middle legs.
		return get_children().reduce(func(acc, child):
				return acc + (1 if child.name.begins_with(AUTO_CONVEYOR_LEG_NAME_PREFIX_MIDDLE) else 0), 0)


@export_group("Head End", "head_end")
## Distance in meters from the head-end of the conveyor to be kept clear of generated conveyor legs.
##
## Prevents any conveyor legs from generating within the given distance of the head-end.
## Useful for ensuring the conveyor leg models don't improperly overlap with the conveyor-end models.[br][br]
##
## A conveyor leg will be generated at this location offset when [member head_end_leg_enabled] is [code]true[/code].
@export_range(0, 1, 0.01, "or_greater", "suffix:m")
var head_end_attachment_offset: float = 0.45:
	set(value):
		if head_end_attachment_offset != value:
			head_end_attachment_offset = value
			_update_conveyor_leg_coverage()
## If [code]true[/code], automatically generate a conveyor leg at the head-end of the conveyor.
## The linear position of this conveyor leg is determined by the length of the conveyor and [member head_end_attachment_offset].
@export
var head_end_leg_enabled: bool = true:
	set(value):
		if head_end_leg_enabled != value:
			head_end_leg_enabled = value
			_set_needs_update(true)
## Distance in meters from the head-end leg to be kept clear of any other conveyor legs.
## When [member head_end_leg_enabled] is [code]true[/code], prevents any conveyor legs from generating within the given distance from the head-end leg.
## When the leg isn't enabled, it has no effect.
## Useful for ensuring an acceptable amount of space separates the head-end leg and the last middle leg.
@export_range(0.5, 5, 0.01, "or_greater", "suffix:m")
var head_end_leg_clearance: float = 0.5:
	set(value):
		if head_end_leg_clearance != value:
			head_end_leg_clearance = value
			_set_needs_update(true)


@export_group("Tail End", "tail_end")
## Distance in meters from the tail-end of the conveyor to be kept clear of generated conveyor legs.
## Prevents any conveyor legs from generating within the given distance of the tail-end.
## Useful for ensuring the conveyor leg models don't improperly overlap with the conveyor-end models.[br][br]
##
## A conveyor leg will be generated at this location offset when [member tail_end_leg_enabled] is [code]true[/code].
@export_range(0, 1, 0.01, "or_greater", "suffix:m")
var tail_end_attachment_offset: float = 0.45:
	set(value):
		if tail_end_attachment_offset != value:
			tail_end_attachment_offset = value
			_update_conveyor_leg_coverage()
## If [code]true[/code], automatically generate a conveyor leg at the tail-end of the conveyor.
## The linear position of this conveyor leg is determined by the length of the conveyor and [member tail_end_attachment_offset].
@export
var tail_end_leg_enabled: bool = true:
	set(value):
		if tail_end_leg_enabled != value:
			tail_end_leg_enabled = value
			_set_needs_update(true)
## Distance in meters from the tail-end leg to be kept clear of any other conveyor legs.
## When [member tail_end_leg_enabled] is [code]true[/code], prevents any conveyor legs from generating within the given distance from the tail-end leg.
## When the leg isn't enabled, it has no effect.
## Useful for ensuring an acceptable amount of space separates the tail-end leg and the first middle leg.
@export_range(0.5, 5, 0.01, "or_greater", "suffix:m")
var tail_end_leg_clearance: float = 0.5:
	set(value):
		if tail_end_leg_clearance != value:
			tail_end_leg_clearance = value
			_set_needs_update(true)


@export_group("Leg Model", "leg_model")
## The scene to instantiate for generated conveyor legs.
@export
var leg_model_scene: PackedScene = preload("res://parts/ConveyorLegBC.tscn"):
	set(value):
		if leg_model_scene != value:
			leg_model_scene = value
			_set_needs_update(true)
## Length in meters of any rotatable tip ("grab") at the top of the conveyor leg model.
## This value affects the position of generated legs when the conveyor is inclined.
@export
var leg_model_grabs_offset: float = 0.132:
	set(value):
		if leg_model_grabs_offset != value:
			leg_model_grabs_offset = value
			_update_conveyor_legs_height_and_visibility()
			_update_conveyor_leg_coverage()


## The conveyor parent that this assembly is attached to.
##
## If this assembly is not the child of a compatible Node, returns [code]null[/code].
var conveyor: Node3D:
	get:
		var parent = get_parent() as Node3D
		if parent != null and parent.has_signal("size_changed") and "size" in parent and parent.size is Vector3:
			return parent
		return null


# Configuration change detection fields
var _conveyors_transform_prev := Transform3D.IDENTITY
var _transform_prev := Transform3D.IDENTITY
var _target_width_prev := NAN
var _middle_legs_enabled_prev := false
var _middle_legs_spacing_prev: float
var _head_end_leg_enabled_prev := false
var _tail_end_leg_enabled_prev := false
var _head_end_leg_clearance_prev := 0.5
var _tail_end_leg_clearance_prev := 0.5
var _leg_model_scene_prev: PackedScene = preload("res://parts/ConveyorLegBC.tscn")

var _conveyor_legs_path_changed := true

# Fields / Conveyor leg coverage
var _conveyor_leg_coverage_min: float
var _conveyor_leg_coverage_max: float
var _conveyor_leg_coverage_min_prev: float
var _conveyor_leg_coverage_max_prev: float
var _conveyor_legs_coverage_changed := false

var _conveyor_connected: bool = false


func _init() -> void:
	set_notify_transform(true)


func _ready() -> void:
	call_deferred("_sync_floor_plane_after_load")


func _sync_floor_plane_after_load() -> void:
	if not is_inside_tree() or not conveyor:
		return

	var current_local_plane = get_local_floor_plane()
	var global_plane = conveyor.global_transform * current_local_plane

	if global_plane.normal != Vector3.ZERO:
		global_floor_plane = global_plane


#region Managing connection to Conveyor's signals
func _notification(what) -> void:
	if what == NOTIFICATION_PARENTED:
		_connect_conveyor()
	elif what == NOTIFICATION_UNPARENTED:
		_disconnect_conveyor_signals()
	elif what == NOTIFICATION_TRANSFORM_CHANGED:
		_on_global_transform_changed()
	elif what == NOTIFICATION_ENTER_TREE:
		_on_global_transform_changed()


func _on_global_transform_changed() -> void:
	_update_floor_plane()
	_update_conveyor_leg_coverage()
	_update_conveyor_legs_height_and_visibility()


func _connect_conveyor() -> void:
	if conveyor != null:
		conveyor.size_changed.connect(_on_conveyor_size_changed)
		_conveyor_connected = true
		call_deferred("_on_conveyor_size_changed")
		# Now is a good time to synchronize the state of the setters with the scene.
		if is_physics_processing():
			call_deferred("_physics_process", 0.0)
	else:
		_conveyor_connected = false
	update_configuration_warnings()


func _disconnect_conveyor_signals() -> void:
	if not _conveyor_connected:
		return
	_conveyor_connected = false
	conveyor.size_changed.disconnect(_on_conveyor_size_changed)


func _get_configuration_warnings() -> PackedStringArray:
	if not _conveyor_connected:
		return ["This node must be a child of a Conveyor or ConveyorAssembly."]
	return []
#endregion

func _on_conveyor_size_changed() -> void:
	_update_conveyor_leg_coverage()
	_update_conveyor_legs_height_and_visibility()
	_update_all_conveyor_legs_width()


func _physics_process(_delta) -> void:
	_update_conveyor_legs()
	_set_needs_update(false)


func _set_needs_update(value: bool) -> void:
	set_physics_process(value)


func get_local_floor_plane() -> Plane:
	var floor_normal: Vector3 = transform.basis.y.normalized()
	var floor_offset = transform.origin.dot(floor_normal)
	return Plane(floor_normal, floor_offset)


func set_local_floor_plane(value: Plane) -> void:
	var old_value = get_local_floor_plane()
	var normal_changed = old_value.normal != value.normal
	var distance_changed = old_value.d != value.d
	_save_local_floor_plane_to_transform(value)
	if normal_changed:
		_update_conveyor_leg_coverage()
	if normal_changed or distance_changed:
		_update_conveyor_legs_height_and_visibility()


func _save_local_floor_plane_to_transform(new_local_floor_plane: Plane) -> void:
	_save_properties_to_local_transform(new_local_floor_plane, middle_legs_initial_leg_position)


func _save_properties_to_local_transform(new_local_floor_plane: Plane, new_middle_legs_initial_leg_position: float) -> void:
	var floor_offset = new_local_floor_plane.d
	var floor_normal = new_local_floor_plane.normal

	var offset_x = new_middle_legs_initial_leg_position
	var offset_y = floor_offset
	var normal_y = floor_normal
	var normal_z = transform.basis.z.normalized()
	var normal_x = normal_y.cross(normal_z).normalized()
	var origin = normal_x * offset_x + normal_y * offset_y
	transform = Transform3D(normal_x, normal_y, normal_z, origin)


func get_middle_legs_initial_leg_position() -> float:
	var normal_x = transform.basis.x.normalized()
	return transform.origin.dot(normal_x)


func set_middle_legs_initial_leg_position(value: float) -> void:
	if (value == get_middle_legs_initial_leg_position()):
		return
	_save_middle_legs_initial_leg_position_to_transform(value)
	_update_conveyor_leg_coverage()


func _save_middle_legs_initial_leg_position_to_transform(new_middle_legs_initial_leg_position: float) -> void:
	_save_properties_to_local_transform(local_floor_plane, new_middle_legs_initial_leg_position)


func _update_conveyor_leg_coverage() -> void:
	var coverage = _get_conveyor_leg_coverage()
	_conveyor_leg_coverage_min = coverage[0]
	_conveyor_leg_coverage_max = coverage[1]
	_conveyor_legs_coverage_changed = _conveyor_leg_coverage_min != _conveyor_leg_coverage_min_prev \
								or _conveyor_leg_coverage_max != _conveyor_leg_coverage_max_prev
	if _conveyor_legs_coverage_changed:
		_set_needs_update(true)


func _get_conveyor_leg_coverage() -> Array[float]:
	if not conveyor:
		return [0.0, 0.0]

	var min_val := INF
	var max_val := -INF

	# Conveyor's Transform in local space.
	var local_conveyor_transform := transform.affine_inverse()

	# Extent and offset positions in unscaled conveyor space.
	var conveyor_extent_front := Vector3(-absf(conveyor.size.x * 0.5), 0.0, 0.0)
	var conveyor_extent_rear := Vector3(absf(conveyor.size.x * 0.5), 0.0, 0.0)

	var margin_offset_front := Vector3(tail_end_attachment_offset, 0.0, 0.0)
	var margin_offset_rear := Vector3(-head_end_attachment_offset, 0.0, 0.0)

	# The tip of the conveyor leg has a rotating grab model that isn't counted towards its height.
	# Because the grab will rotate towards the conveyor, we account for its reach here.
	# Grab the bottom of the conveyor.
	var conveyor_depth = conveyor.size.y
	var grab_offset := Vector3(0.0, -leg_model_grabs_offset - conveyor_depth, 0.0)

	var leg_grab_point_front := local_conveyor_transform.orthonormalized() * (conveyor_extent_front + margin_offset_front + grab_offset)
	var leg_grab_point_rear := local_conveyor_transform.orthonormalized() * (conveyor_extent_rear + margin_offset_rear + grab_offset)

	min_val = minf(min_val, minf(leg_grab_point_rear.x, leg_grab_point_front.x))
	max_val = maxf(max_val, maxf(leg_grab_point_rear.x, leg_grab_point_front.x))

	return [min_val, max_val]


func _update_floor_plane() -> void:
	if not is_inside_tree() or conveyor == null:
		return
	if has_meta("is_preview"):
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


func _update_conveyor_legs() -> void:
	if conveyor == null:
		return

	# If the conveyor leg scene changes, we need to regenerate everything.
	if leg_model_scene != _leg_model_scene_prev:
		_delete_all_auto_conveyor_legs()

	# Only bother repositioning conveyor legs if the user could manually edit them.
	# All the conveyor legs that we generated should already be in the right spots.
	var edited_root = get_tree().get_edited_scene_root() if is_inside_tree() else null
	var conveyor_legs_assembly_is_editable = false
	if not has_meta("is_preview"):
		conveyor_legs_assembly_is_editable = edited_root != null and owner != null and (edited_root == owner or edited_root.is_editable_instance(owner))
	if conveyor_legs_assembly_is_editable or _conveyor_legs_path_changed:
		_snap_all_conveyor_legs_to_path()

	_conveyor_legs_path_changed = false

	_update_all_conveyor_legs_width()

	var debug_invariants := true
	var conveyor_leg_coverage_min_value_for_assertion: float = 0.0
	var conveyor_leg_coverage_max_value_for_assertion: float = 0.0
	if debug_invariants:
		conveyor_leg_coverage_min_value_for_assertion = _conveyor_leg_coverage_min
		conveyor_leg_coverage_max_value_for_assertion = _conveyor_leg_coverage_max

	var auto_conveyor_legs_update_is_needed: bool = middle_legs_enabled != _middle_legs_enabled_prev \
		or middle_legs_spacing != _middle_legs_spacing_prev \
		or head_end_leg_enabled != _head_end_leg_enabled_prev \
		or tail_end_leg_enabled != _tail_end_leg_enabled_prev \
		or head_end_leg_clearance != _head_end_leg_clearance_prev \
		or tail_end_leg_clearance != _tail_end_leg_clearance_prev \
		or leg_model_scene != _leg_model_scene_prev \
		or _conveyor_legs_coverage_changed

	var number_of_conveyor_legs_adjusted: int = 0
	var did_add_or_remove := false
	if auto_conveyor_legs_update_is_needed:
		number_of_conveyor_legs_adjusted = _adjust_auto_conveyor_leg_positions()
		did_add_or_remove = _create_and_remove_auto_conveyor_legs()

	# Dependencies
	var children_changed: bool = number_of_conveyor_legs_adjusted != 0 or did_add_or_remove
	# Actually, it's the relative transform of ConveyorLegsAssembly and conveyor that we need to monitor,
	# specifically the conveyor_plane in _update_conveyor_legs_height_and_visibility,
	# but the individual transforms are good enough for now, though overkill.
	var conveyor_transform_changed: bool = conveyor.transform != _conveyors_transform_prev
	var conveyor_legs_transform_changed: bool = transform != _transform_prev
	if children_changed or conveyor_transform_changed or conveyor_legs_transform_changed or _conveyor_legs_coverage_changed:
		_update_conveyor_legs_height_and_visibility()

	# Record external state to detect any changes next run.
	_conveyors_transform_prev = conveyor.transform
	_transform_prev = transform
	_middle_legs_enabled_prev = middle_legs_enabled
	_head_end_leg_enabled_prev = head_end_leg_enabled
	_tail_end_leg_enabled_prev = tail_end_leg_enabled
	_head_end_leg_clearance_prev = head_end_leg_clearance
	_tail_end_leg_clearance_prev = tail_end_leg_clearance
	_leg_model_scene_prev = leg_model_scene
	_conveyor_leg_coverage_min_prev = _conveyor_leg_coverage_min
	_conveyor_leg_coverage_max_prev = _conveyor_leg_coverage_max

	if debug_invariants:
		assert(_conveyor_leg_coverage_min == conveyor_leg_coverage_min_value_for_assertion, "Unexpected change detected: _conveyor_leg_coverage_min")
		assert(_conveyor_leg_coverage_max == conveyor_leg_coverage_max_value_for_assertion, "Unexpected change detected: _conveyor_leg_coverage_max")


func _delete_all_auto_conveyor_legs() -> void:
	for child in get_children():
		if _is_auto_conveyor_leg(child):
			# Setting owner to null prevents an error during drag and drop instantiation.
			# "ERROR: Invalid owner. Owner must be an ancestor in the tree."
			# A Godot bug, perhaps?
			child.owner = null
			remove_child(child)
			child.queue_free()


static func _is_auto_conveyor_leg(node: Node) -> bool:
	return _get_auto_conveyor_leg_index(node.name) != LegIndex.NON_AUTO



func _snap_all_conveyor_legs_to_path() -> void:
	# Force conveyor leg alignment with conveyor path.
	for child in get_children():
		if not child is ConveyorLeg:
			continue
		_snap_to_conveyor_legs_path(child)


func _update_all_conveyor_legs_width() -> void:
	var target_width_new = _get_conveyor_leg_target_width()
	var target_width_changed = _target_width_prev != target_width_new
	_target_width_prev = target_width_new
	if not target_width_changed:
		return
	for child in get_children():
		if not child is ConveyorLeg:
			continue
		_update_conveyor_leg_width(child)


func _update_conveyor_leg_width(conveyor_leg: Node3D) -> void:
	var target_width := _get_conveyor_leg_target_width()
	conveyor_leg.scale = Vector3(1.0, conveyor_leg.scale.y, target_width / CONVEYOR_LEGS_BASE_WIDTH)


func _get_conveyor_leg_target_width() -> float:
	if conveyor == null:
		# Fall back to something. Doesn't matter what.
		# This only happens during duplication.
		# The duplicated legs will be updated with the correct width once we enter the tree.
		return CONVEYOR_LEGS_BASE_WIDTH
	# This is a hack to account for the fact that CurvedRollerConveyors are slightly wider than other conveyors
	var conveyor_width: float = conveyor.size.z
	# Check for CurvedRollerConveyor by class name to work with assemblies
	if conveyor.get_script() and conveyor.get_script().get_global_name() == "CurvedRollerConveyor":
		return conveyor_width * 1.010
	# TODO: Make this check not depend on concrete type.
	# It should also work for conveyor assemblies that forward their conveyor's info.
	# Perhaps it should be coupled to the leg model instead?
	if conveyor is RollerConveyor:
		return conveyor_width + 0.051 * 2.0
	return conveyor_width


## Snap a child conveyor leg to a position on the conveyor legs path.
##
## The conveyor legs path is a surface parallel to ConveyorLegsAssembly's Y axis.
## It represents any position that the conveyor line would be directly above or below at some length.
## For straight assemblies, this is ConveyorLegsAssembly's XY plane.
## For curved assemblies, this is overridden to be a cylinder centered on ConveyorLegsAssembly.
func _snap_to_conveyor_legs_path(conveyor_leg: Node3D) -> void:
	_move_conveyor_leg_to_path_position(conveyor_leg, _get_position_on_conveyor_legs_path(conveyor_leg.position))


## Get the path position of a point projected onto the conveyor legs path.
##
## The path position is a linear representation of where a point is on the conveyor legs path.
## For straight assemblies, this is the X coordinate of the point.
## For curved assemblies, this is an angle of the point around the conveyor legs Y axis in degrees.
func _get_position_on_conveyor_legs_path(position: Vector3) -> float:
	return position.x


## Move a conveyor leg to a given position on the conveyor legs path.
##
## The conveyor leg is moved and rotated to align with the path.
## The conveyor leg keeps its Y position and Z rotation.
## Curved assemblies override this and don't keep the Z rotation.
func _move_conveyor_leg_to_path_position(conveyor_leg: Node3D, path_position: float) -> bool:
	var changed := false
	var new_position := Vector3(path_position, conveyor_leg.position.y, 0.0)
	if conveyor_leg.position != new_position:
		conveyor_leg.position = new_position
		changed = true

	var new_rotation := Vector3(0.0, 0.0, conveyor_leg.rotation.z)
	if conveyor_leg.rotation != new_rotation:
		conveyor_leg.rotation = new_rotation
		changed = true

	return changed


## Adjust the positions of all auto-instanced conveyor legs to match changed settings or coverage.
func _adjust_auto_conveyor_leg_positions() -> int:
	# Don't allow tiny or negative intervals.
	middle_legs_spacing = maxf(MIDDLE_LEGS_SPACING_MIN, middle_legs_spacing)
	if middle_legs_spacing == _middle_legs_spacing_prev and \
			_conveyor_leg_coverage_max == _conveyor_leg_coverage_max_prev and \
			_conveyor_leg_coverage_min == _conveyor_leg_coverage_min_prev and \
			tail_end_leg_enabled == _tail_end_leg_enabled_prev and \
			(tail_end_leg_clearance == _tail_end_leg_clearance_prev or not tail_end_leg_enabled):
		return 0

	var change_count := 0
	for child in get_children():
		if not child is ConveyorLeg:
			continue

		var conveyor_leg_index := _get_auto_conveyor_leg_index(child.name)
		match conveyor_leg_index:
			LegIndex.NON_AUTO:
				# Only adjust auto conveyor legs.
				pass
			_:
				if _move_conveyor_leg_to_path_position(child, _get_auto_conveyor_leg_position(conveyor_leg_index)):
					change_count += 1

	_middle_legs_spacing_prev = middle_legs_spacing
	return change_count


static func _get_auto_conveyor_leg_index(name: StringName) -> int:
	if name == AUTO_CONVEYOR_LEG_NAME_FRONT:
		return LegIndex.FRONT
	if name == AUTO_CONVEYOR_LEG_NAME_REAR:
		return LegIndex.REAR
	if name.begins_with(AUTO_CONVEYOR_LEG_NAME_PREFIX_MIDDLE):
		var index_str = name.substr(AUTO_CONVEYOR_LEG_NAME_PREFIX_MIDDLE.length())
		if index_str.is_valid_int():
			# Names start at 1, but indices start at 0.
			return index_str.to_int() - 1
	return LegIndex.NON_AUTO


func _get_auto_conveyor_leg_position(index: int) -> float:
	if index == LegIndex.FRONT:
		return _conveyor_leg_coverage_min
	if index == LegIndex.REAR:
		return _conveyor_leg_coverage_max
	return _get_interval_conveyor_leg_position(index)


func _get_interval_conveyor_leg_position(index: int) -> float:
	assert(index >= 0)
	# Don't allow negative clearance.
	tail_end_leg_clearance = maxf(0.0, tail_end_leg_clearance)
	var front_margin = tail_end_leg_clearance if tail_end_leg_enabled else 0.0
	var first_position = ceili((_conveyor_leg_coverage_min + front_margin) / middle_legs_spacing) * middle_legs_spacing
	return first_position + index * middle_legs_spacing


func _get_desired_interval_conveyor_leg_count() -> int:
	# Don't allow negative clearance.
	head_end_leg_clearance = maxf(0.0, head_end_leg_clearance)
	# Enforce a margin from fixed front and rear legs if they exist.
	var first_position := _get_interval_conveyor_leg_position(0)
	var rear_margin: float = head_end_leg_clearance if head_end_leg_enabled else 0.0
	var last_position: float = floorf((_conveyor_leg_coverage_max - rear_margin) / middle_legs_spacing) * middle_legs_spacing

	var interval_conveyor_leg_count: int
	if not middle_legs_enabled:
		interval_conveyor_leg_count = 0
	elif first_position > last_position:
		# Invalid range implies zero interval-aligned conveyor legs are needed.
		interval_conveyor_leg_count = 0
	else:
		interval_conveyor_leg_count = int((last_position - first_position) / middle_legs_spacing) + 1
	return interval_conveyor_leg_count


func _create_and_remove_auto_conveyor_legs(interval_conveyor_leg_count=null) -> bool:
	if interval_conveyor_leg_count == null:
		interval_conveyor_leg_count = _get_desired_interval_conveyor_leg_count()
	var changed := false
	# Inventory our existing conveyor legs and delete the ones we don't need.
	var has_front_leg := false
	var has_rear_leg := false
	var conveyor_legs_inventory: Array[bool] = []
	conveyor_legs_inventory.resize(interval_conveyor_leg_count)
	conveyor_legs_inventory.fill(false)

	for child in get_children():
		if not child is ConveyorLeg:
			continue

		var conveyor_leg_index := _get_auto_conveyor_leg_index(child.name)
		match conveyor_leg_index:
			LegIndex.NON_AUTO:
				# Only manage auto conveyor legs.
				pass
			LegIndex.FRONT:
				if tail_end_leg_enabled:
					has_front_leg = true
				else:
					remove_child(child)
					child.queue_free()
			LegIndex.REAR:
				if head_end_leg_enabled:
					has_rear_leg = true
				else:
					remove_child(child)
					child.queue_free()
			_:
				# Mark existing conveyor legs that are in the new interval.
				if conveyor_leg_index < interval_conveyor_leg_count and middle_legs_enabled:
					conveyor_legs_inventory[conveyor_leg_index] = true
				else:
					# Delete conveyor legs that are outside the new interval.
					remove_child(child)
					child.queue_free()
					changed = true

	# Create the missing conveyor legs.
	if leg_model_scene == null:
		return changed

	if not has_front_leg and tail_end_leg_enabled:
		_add_conveyor_leg_at_index(LegIndex.FRONT)
		changed = true

	for i in interval_conveyor_leg_count:
		if not conveyor_legs_inventory[i]:
			_add_conveyor_leg_at_index(i)
			changed = true

	if not has_rear_leg and head_end_leg_enabled:
		_add_conveyor_leg_at_index(LegIndex.REAR)
		changed = true

	return changed


func _add_conveyor_leg_at_index(index: int) -> ConveyorLeg:
	var position: float = _get_auto_conveyor_leg_position(index)
	var name: StringName

	match index:
		LegIndex.FRONT:
			name = &"ConveyorLegTail"
		LegIndex.REAR:
			name = &"ConveyorLegHead"
		_:
			# Indices start at 0, but names start at 1.
			name = &"ConveyorLegMiddle%d" % (index + 1)

	var conveyor_leg := _add_or_get_conveyor_leg_instance(name) as ConveyorLeg
	_move_conveyor_leg_to_path_position(conveyor_leg, position)
	_update_conveyor_leg_width(conveyor_leg)

	# It probably doesn't matter, but let's try to keep conveyor legs in order.
	var true_index: int
	match index:
		LegIndex.FRONT:
			true_index = 0
		LegIndex.REAR:
			true_index = -1
		_:
			true_index = index + 1 if head_end_leg_enabled else index

	if true_index < get_child_count():
		move_child(conveyor_leg, true_index)

	return conveyor_leg


func _add_or_get_conveyor_leg_instance(name: StringName) -> Node:
	var conveyor_leg := get_node_or_null(NodePath(name))
	if conveyor_leg != null:
		return conveyor_leg

	conveyor_leg = leg_model_scene.instantiate()
	conveyor_leg.name = name
	add_child(conveyor_leg)
	return conveyor_leg


func _update_conveyor_legs_height_and_visibility() -> void:
	if not conveyor:
		return

	# Plane transformed from conveyors space into local space.
	var conveyor_plane = Plane(Vector3.UP, Vector3(0, -leg_model_grabs_offset - conveyor.size.y, 0)) \
		* transform

	for child in get_children():
		var conveyor_leg = child as ConveyorLeg
		if conveyor_leg:
			_update_individual_conveyor_leg_height_and_visibility(conveyor_leg, conveyor_plane)


func _update_individual_conveyor_leg_height_and_visibility(conveyor_leg: ConveyorLeg, conveyor_plane: Plane) -> void:
	# Raycast from the minimum-height tip of the conveyor leg to the conveyor plane.
	var intersection = conveyor_plane.intersects_ray(
		conveyor_leg.position + conveyor_leg.basis.y.normalized(),
		conveyor_leg.basis.y.normalized()
	)

	if not intersection:
		conveyor_leg.visible = false
		# Set scale to minimum height.
		conveyor_leg.scale = Vector3(1.0, 1.0, conveyor_leg.scale.z)
		return

	var leg_height = intersection.distance_to(conveyor_leg.position)
	conveyor_leg.scale = Vector3(1.0, leg_height, conveyor_leg.scale.z)
	conveyor_leg.grabs_rotation = rad_to_deg(conveyor_leg.basis.y.signed_angle_to(
		conveyor_plane.normal.slide(conveyor_leg.basis.z.normalized()),
		conveyor_leg.basis.z
	))

	# Only show conveyor legs that touch a conveyor.
	var tip_position = _get_position_on_conveyor_legs_path(conveyor_leg.position + conveyor_leg.basis.y)
	conveyor_leg.visible = _conveyor_leg_coverage_min <= tip_position and tip_position <= _conveyor_leg_coverage_max


## Called by curved conveyor when inner_radius or conveyor_width changes
func update_for_curved_conveyor(inner_radius: float, conveyor_width: float, conveyor_size: Vector3, conveyor_angle: float) -> void:
	if not is_inside_tree():
		return

	# For curved conveyors, force immediate update of coverage and leg positioning
	_update_conveyor_leg_coverage()
	_set_needs_update(true)

	# Update immediately rather than waiting for physics process
	if conveyor:
		_update_conveyor_legs()
		_update_conveyor_legs_height_and_visibility()
