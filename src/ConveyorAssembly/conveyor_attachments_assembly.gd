@tool
class_name ConveyorAttachmentsAssembly
extends ResizableNode3D

## Base for conveyor assemblies with `%ConveyorLegsAssembly` / `%SideGuardsAssembly`
## children. Owns cached property forwarding, collision pass-through, side-guard
## detail routing, and the outer `FrameRail`s.
##
## Leaf classes declare the legs + side-guards `@export`s themselves so Godot
## groups them under the leaf's inspector category rather than this one.

const SIDE_GUARDS_SCRIPT_PATH: String = "res://src/ConveyorAttachment/side_guards_assembly.gd"
const SIDE_GUARDS_SCRIPT_FILENAME: String = "side_guards_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH: String = "res://src/ConveyorAttachment/conveyor_legs_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME: String = "conveyor_legs_assembly.gd"

## Conveyor-child properties that should never bubble up to the assembly
## inspector (the assembly has its own `size`, `hijack_scale` is internal, etc.).
const EXCLUDED_FORWARDED_PROPERTIES: PackedStringArray = [
	"size", "original_size", "transform_in_progress",
	"size_min", "size_default", "hijack_scale",
]

var _has_instantiated: bool = false
var _cached_side_guards_property_values: Dictionary[StringName, Variant] = {}
var _cached_legs_property_values: Dictionary[StringName, Variant] = {}

var _frame_left: FrameRail
var _frame_right: FrameRail
@export_storage var _frame_rail_state: Dictionary = {}

var _flow_arrow: Node3D


func _ready() -> void:
	_ensure_frame_rails()
	_flush_cache_into_unique("%SideGuardsAssembly", _cached_side_guards_property_values)
	_flush_cache_into_unique("%ConveyorLegsAssembly", _cached_legs_property_values)
	_has_instantiated = true
	update_gizmos()
	_update_flow_arrow()
	call_deferred("_ensure_side_guards_updated")


func _on_size_changed() -> void:
	_update_flow_arrow()


func _update_flow_arrow() -> void:
	if _flow_arrow:
		FlowDirectionArrow.unregister(_flow_arrow)
		_flow_arrow.queue_free()
	_flow_arrow = FlowDirectionArrow.create(size)
	add_child(_flow_arrow, false, Node.INTERNAL_MODE_FRONT)
	FlowDirectionArrow.register(_flow_arrow)


func _exit_tree() -> void:
	if _flow_arrow:
		FlowDirectionArrow.unregister(_flow_arrow)
	super._exit_tree()


func _flush_cache_into_unique(unique_name: String, cache: Dictionary) -> void:
	if not has_node(unique_name):
		return
	var target := get_node(unique_name)
	if not target.property_list_changed.is_connected(notify_property_list_changed):
		target.property_list_changed.connect(notify_property_list_changed)
	for property: StringName in cache:
		target.set(property, cache[property])
	cache.clear()


func _validate_property(property: Dictionary) -> void:
	if property[&"name"] == SIDE_GUARDS_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(SIDE_GUARDS_SCRIPT_PATH.get_file() == SIDE_GUARDS_SCRIPT_FILENAME, "SIDE_GUARDS_SCRIPT_PATH doesn't match SIDE_GUARDS_SCRIPT_FILENAME")
		property[&"hint_string"] = SIDE_GUARDS_SCRIPT_PATH
	elif property[&"name"] == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH.get_file() == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME, "CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH doesn't match CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME")
		property[&"hint_string"] = CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH


func _set(property: StringName, value: Variant) -> bool:
	if _is_side_guard_detail_property(property):
		if has_node("%SideGuardsAssembly"):
			%SideGuardsAssembly.set(property, value)
			update_gizmos()
		return true
	return false


func _get(property: StringName) -> Variant:
	if _is_side_guard_detail_property(property):
		if has_node("%SideGuardsAssembly"):
			return %SideGuardsAssembly.get(property)
		return null
	return null


func _collision_repositioned_save() -> Variant:
	return get(&"floor_plane")


func _collision_repositioned(collision_point: Vector3, collision_normal: Vector3) -> void:
	if _has_instantiated and has_node("%ConveyorLegsAssembly"):
		%ConveyorLegsAssembly.collision_repositioned(collision_point, collision_normal)


func _collision_repositioned_undo(saved_data: Variant) -> void:
	if saved_data is Plane and _has_instantiated and has_node("%ConveyorLegsAssembly"):
		%ConveyorLegsAssembly.restore_floor_plane(saved_data)


func _ensure_side_guards_updated() -> void:
	if has_node("%SideGuardsAssembly"):
		%SideGuardsAssembly._on_conveyor_size_changed()


static func _is_side_guard_detail_property(property: StringName) -> bool:
	return property.begins_with("left_side_guards_guard_") or property.begins_with("right_side_guards_guard_")


func _disable_collisions_recursive(node: Node) -> void:
	if node is CollisionShape3D:
		node.disabled = true
	if node is CollisionObject3D:
		node.collision_layer = 0
		node.collision_mask = 0
	for child in node.get_children(true):
		_disable_collisions_recursive(child)


func _apply_preview_common(preview_node: Node3D) -> void:
	_disable_collisions_recursive(preview_node)
	for unique_name in ["%ConveyorLegsAssembly", "%SideGuardsAssembly"]:
		var attachment = preview_node.get_node_or_null(unique_name)
		if is_instance_valid(attachment):
			attachment.set_meta("is_preview", true)
			attachment.set_process_mode(Node.PROCESS_MODE_DISABLED)
	preview_node.add_child(FlowDirectionArrow.create(preview_node.size))


func _side_guards_property_cached_set(property: StringName, value: Variant, _existing_backing_field_value: Variant) -> Variant:
	if has_node("%SideGuardsAssembly"):
		%SideGuardsAssembly.set(property, value)
	else:
		_cached_side_guards_property_values[property] = value
	return value


func _legs_property_cached_set(property: StringName, value: Variant, _existing_backing_field_value: Variant) -> Variant:
	if has_node("%ConveyorLegsAssembly"):
		%ConveyorLegsAssembly.set(property, value)
	else:
		_cached_legs_property_values[property] = value
	return value


func _side_guards_property_cached_get(property: StringName, backing_field_value: Variant) -> Variant:
	if has_node("%SideGuardsAssembly"):
		var value: Variant = %SideGuardsAssembly.get(property)
		if value != null:
			return value
	return backing_field_value


func _legs_property_cached_get(property: StringName, backing_field_value: Variant) -> Variant:
	if has_node("%ConveyorLegsAssembly"):
		var value: Variant = %ConveyorLegsAssembly.get(property)
		if value != null:
			return value
	return backing_field_value


#region Frame rails

func _ensure_frame_rails() -> void:
	if has_node("%Conveyor") and "frame_managed_externally" in %Conveyor:
		%Conveyor.frame_managed_externally = true
	if not _frame_left:
		_frame_left = FrameRail.new()
		_frame_left.name = "FrameLeft"
		add_child(_frame_left)
	if not _frame_right:
		_frame_right = FrameRail.new()
		_frame_right.name = "FrameRight"
		add_child(_frame_right)
	_restore_frame_rail_state()


func _update_frame_rails() -> void:
	if not _frame_left or not _frame_right:
		return

	var half_w := size.z / 2.0
	var wt := ConveyorFrameMesh.WALL_THICKNESS
	var height := size.y

	var left_extents := _get_frame_rail_extents(-half_w)
	var right_extents := _get_frame_rail_extents(half_w)

	_apply_frame_rail(_frame_left, left_extents, height, -half_w - wt, false)
	_apply_frame_rail(_frame_right, right_extents, height, half_w + wt, true)
	_save_frame_rail_state()


# Subclasses override this to apply splay (e.g. spurs).
func _get_frame_rail_extents(_side_z: float) -> Array[float]:
	var half_length := size.x / 2.0
	return [-half_length, half_length]


func _apply_frame_rail(rail: FrameRail, extents: Array[float], height: float, z_pos: float, flipped: bool) -> void:
	var back_x: float = extents[0]
	var front_x: float = extents[1]
	var rail_length: float = max(0.01, front_x - back_x)
	var center_x: float = (front_x + back_x) / 2.0

	var old_front: float = rail.position.x + rail.length / 2.0
	var old_back: float = rail.position.x - rail.length / 2.0
	if rail.front_boundary_tracking and front_x > old_front + 0.001:
		rail.front_anchored = true
		rail.front_boundary_tracking = false
	if rail.back_boundary_tracking and back_x < old_back - 0.001:
		rail.back_anchored = true
		rail.back_boundary_tracking = false

	rail.height = height
	if rail.front_anchored and rail.back_anchored:
		rail.length = rail_length
		rail.position = Vector3(center_x, -height, z_pos)
	else:
		rail.position.y = -height
		rail.position.z = z_pos
	rail.rotation = Vector3(0, PI, 0) if flipped else Vector3.ZERO
	rail.visible = true


func _save_frame_rail_state() -> void:
	var state: Dictionary = {}
	var rails := {"left": _frame_left, "right": _frame_right}
	for key in rails:
		var rail: FrameRail = rails[key]
		if not rail:
			continue
		state[key] = {
			"pos_x": rail.position.x,
			"length": rail.length,
			"front_anchored": rail.front_anchored,
			"back_anchored": rail.back_anchored,
			"front_boundary_tracking": rail.front_boundary_tracking,
			"back_boundary_tracking": rail.back_boundary_tracking,
		}
	_frame_rail_state = state


func _restore_frame_rail_state() -> void:
	if _frame_rail_state.is_empty():
		return
	var rails := {"left": _frame_left, "right": _frame_right}
	for key in rails:
		var rail: FrameRail = rails[key]
		if not rail or not _frame_rail_state.has(key):
			continue
		var s: Dictionary = _frame_rail_state[key]
		rail.position.x = float(s["pos_x"])
		rail.length = float(s["length"])
		rail.front_anchored = bool(s["front_anchored"])
		rail.back_anchored = bool(s["back_anchored"])
		rail.front_boundary_tracking = bool(s["front_boundary_tracking"])
		rail.back_boundary_tracking = bool(s["back_boundary_tracking"])

#endregion
