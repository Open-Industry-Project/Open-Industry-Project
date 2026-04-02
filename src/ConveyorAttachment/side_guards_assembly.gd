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
		_request_update()

@export_subgroup("Left Side Guards", "left_side_guards_")
## If [code]true[/code], automatically generate side guards on the left-hand side of the conveyor.
@export var left_side_guards_enabled: bool = true:
	set(value):
		left_side_guards_enabled = value
		_request_update()


## Stored last-known conveyor extents per side, used to detect resize deltas.
var _last_extents: Dictionary = {}
## Stored last-known global transform per side, used to maintain global positions of openings.
var _last_side_global_transforms: Dictionary = {}
var _conveyor_connected: bool = false
## Persisted guard layout (forwarded to/from the assembly root for serialization).
var _guard_state: Dictionary = {}
## Cached guard count per side — used to detect when property list needs refresh.
var _last_guard_count: Dictionary = {}


func _ready() -> void:
	_last_extents = {}
	_last_side_global_transforms = {}


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
	if conveyor and conveyor.has_signal("size_changed") and conveyor.size_changed.is_connected(_on_conveyor_size_changed):
		conveyor.size_changed.disconnect(_on_conveyor_size_changed)


var _update_pending: bool = false


func _request_update() -> void:
	if not _update_pending and is_inside_tree():
		_update_pending = true
		call_deferred("_deferred_update")


func _deferred_update() -> void:
	_update_pending = false
	_update_side_guards()


func _on_conveyor_size_changed() -> void:
	_update_side_guards()


func _update_side_guards() -> void:
	if not is_inside_tree():
		return
	_update_pending = false
	transform = Transform3D()
	_update_side(Side.LEFT, left_side_guards_enabled)
	_update_side(Side.RIGHT, right_side_guards_enabled)
	save_guard_state()


func _update_side(side: SideGuardsAssembly.Side, side_enabled: bool) -> void:
	if not is_inside_tree():
		return
	if not side_enabled:
		_clear_side(side)
		return
	var side_node: Node3D = _ensure_side(side)
	side_node.transform = _get_side_node_transform(side)
	var new_side_global: Transform3D = side_node.global_transform
	var old_side_global: Transform3D = _last_side_global_transforms.get(side, new_side_global)

	var extents: Array[float] = _get_side_extents(side)
	if side_node.get_child_count() == 0:
		# Try restoring from saved state first.
		if not _restore_guard_state(side_node, side):
			# No saved state: spawn a full-length guard.
			_spawn_default_guard(side_node, side, extents)
	else:
		# Resize: adjust guards that are anchored to conveyor edges.
		# Pass old/new global transforms so non-anchored edges maintain their world position.
		_adjust_anchored_guards(side_node, side, extents, old_side_global, new_side_global)

	# Store extents and global transform for next resize delta.
	_last_extents[side] = extents
	_last_side_global_transforms[side] = side_node.global_transform
	_check_guard_count_changed()


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
	# Offset to align sideguard outer face with frame outer face.
	var offset_z: float = conveyor_width / 2.0 + ConveyorFrameMesh.WALL_THICKNESS
	match side:
		Side.LEFT:
			return Transform3D(Basis.IDENTITY, Vector3(0, 0, -offset_z))
		Side.RIGHT:
			return Transform3D(Basis.IDENTITY, Vector3(0, 0, offset_z))
		_:
			assert(false, "Unknown side: " + str(side))
			return Transform3D()


func _get_side_node_name(side: SideGuardsAssembly.Side) -> StringName:
	match side:
		Side.LEFT:
			return "LeftSide"
		Side.RIGHT:
			return "RightSide"
		_:
			assert(false, "Unknown side: " + str(side))
			return &""


func _get_side_extents(side: SideGuardsAssembly.Side) -> Array[float]:
	var conveyor = get_parent()

	if "angle_downstream" in conveyor and "angle_upstream" in conveyor:
		return _get_spur_side_extents(side, conveyor)

	var conveyor_length: float = conveyor.size.x
	var extents: Array[float] = [-conveyor_length / 2.0, conveyor_length / 2.0]
	return extents


func _get_spur_side_extents(side: SideGuardsAssembly.Side, conveyor: Node3D) -> Array[float]:
	var length: float = conveyor.size.x
	var width: float = conveyor.size.z
	var angle_ds: float = conveyor.angle_downstream
	var angle_us: float = conveyor.angle_upstream
	var half_w: float = width / 2.0

	var side_z: float
	match side:
		Side.LEFT:
			side_z = -half_w
		Side.RIGHT:
			side_z = half_w
		_:
			side_z = 0.0

	var front_x: float = length / 2.0 + tan(angle_ds) * side_z
	var back_x: float = -length / 2.0 + tan(angle_us) * side_z
	return [back_x, front_x]


#region Guard spawning and anchored resize

## Spawn a single full-length guard for the given side.
func _spawn_default_guard(side_node: Node3D, side: SideGuardsAssembly.Side, extents: Array[float]) -> void:
	var guard := _instantiate_guard()
	var ext_start: float = extents[0]
	var ext_end: float = extents[1]
	var guard_length: float = ext_end - ext_start
	var pos := Vector3((ext_start + ext_end) / 2.0, 0, 0)

	var guard_basis := Basis.IDENTITY
	match side:
		Side.RIGHT:
			guard_basis = Basis(Vector3.UP, PI)

	guard.transform = Transform3D(guard_basis, pos)
	guard.length = max(0.01, guard_length)
	guard.front_anchored = true
	guard.back_anchored = true
	side_node.add_child(guard)



## Adjust guards whose edges are anchored to the conveyor boundary.
## Non-anchored edges maintain their global position using the old/new side-node transforms.
func _adjust_anchored_guards(side_node: Node3D, side: SideGuardsAssembly.Side, extents: Array[float], old_side_global: Transform3D, new_side_global: Transform3D) -> void:
	var old_extents: Array = _last_extents.get(side, extents)
	var old_back: float = old_extents[0]
	var old_front: float = old_extents[1]
	var new_back: float = extents[0]
	var new_front: float = extents[1]

	# Converts old local positions to new local positions that keep the same global position.
	var global_remap: Transform3D = new_side_global.affine_inverse() * old_side_global

	for child in side_node.get_children():
		if not child is SideGuard:
			continue
		var guard := child as SideGuard
		var g_front: float = guard.position.x + guard.length / 2.0
		var g_back: float = guard.position.x - guard.length / 2.0

		# Non-anchored edges: remap to maintain global position.
		# Anchored edges at boundary: track to new boundary.
		if not guard.front_anchored:
			g_front = (global_remap * Vector3(g_front, 0, 0)).x
		elif abs(g_front - old_front) < 0.01:
			g_front = new_front

		if not guard.back_anchored:
			g_back = (global_remap * Vector3(g_back, 0, 0)).x
		elif abs(g_back - old_back) < 0.01:
			g_back = new_back

		g_front = minf(g_front, new_front)
		g_back = maxf(g_back, new_back)

		var new_length: float = max(0.01, g_front - g_back)
		var new_center: float = (g_front + g_back) / 2.0

		guard.position = Vector3(new_center, guard.position.y, guard.position.z)
		guard.length = new_length

		# Preserve the basis (right side is rotated 180°).
		var guard_basis := Basis.IDENTITY
		match side:
			Side.RIGHT:
				guard_basis = Basis(Vector3.UP, PI)
		guard.transform = Transform3D(guard_basis, guard.position)


## Save the current guard state so the assembly root can serialize it.
func save_guard_state() -> void:
	var state: Dictionary = {}
	for side_name in ["LeftSide", "RightSide"]:
		var side_node := get_node_or_null(side_name) as Node3D
		if not side_node:
			continue
		var idx := 0
		for child in side_node.get_children():
			if child is SideGuard:
				var guard := child as SideGuard
				var key: String = side_name + "_" + str(idx)
				state[key] = {
					"pos_x": guard.position.x,
					"length": guard.length,
					"front_anchored": guard.front_anchored,
					"back_anchored": guard.back_anchored,
				}
				idx += 1
	_guard_state = state
	_check_guard_count_changed()


## Restore guards from persisted state. Returns true if state was restored.
func _restore_guard_state(side_node: Node3D, side: SideGuardsAssembly.Side) -> bool:
	if _guard_state.is_empty():
		return false

	var side_name: String = _get_side_node_name(side)

	# Collect entries for this side.
	var entries: Array[Dictionary] = []
	var idx := 0
	while _guard_state.has(side_name + "_" + str(idx)):
		entries.append(_guard_state[side_name + "_" + str(idx)])
		idx += 1

	if entries.is_empty():
		return false

	# Recreate guards from saved state.
	for entry in entries:
		var guard := _instantiate_guard()
		var guard_basis := Basis.IDENTITY
		match side:
			Side.RIGHT:
				guard_basis = Basis(Vector3.UP, PI)
		guard.transform = Transform3D(guard_basis, Vector3(float(entry["pos_x"]), 0, 0))
		guard.length = float(entry["length"])
		guard.front_anchored = bool(entry["front_anchored"])
		guard.back_anchored = bool(entry["back_anchored"])
		side_node.add_child(guard)
	return true


func _instantiate_guard() -> SideGuard:
	var guard := SideGuard.new()
	guard.name = "SideGuard"
	# Add collision body.
	var body := StaticBody3D.new()
	body.name = "StaticBody3D"
	body.disable_mode = StaticBody3D.DISABLE_MODE_MAKE_STATIC
	body.collision_mask = 8
	body.ghost_collision_filtering_enabled = true
	var physics_mat := PhysicsMaterial.new()
	physics_mat.friction = 0.0
	body.physics_material_override = physics_mat
	var collision := CollisionShape3D.new()
	collision.name = "CollisionShape3D"
	collision.shape = BoxShape3D.new()
	body.add_child(collision)
	guard.add_child(body)
	return guard


#endregion


#region Dynamic inspector properties

func _get_property_list() -> Array[Dictionary]:
	var props: Array[Dictionary] = []
	for side_data in _get_side_data():
		var guards := _get_guards_for_side(side_data["side"])
		if guards.is_empty():
			continue
		props.append({
			"name": side_data["label"],
			"type": TYPE_NIL,
			"usage": PROPERTY_USAGE_GROUP,
			"hint_string": side_data["prefix"],
		})
		for idx in guards.size():
			var p: String = side_data["prefix"] + "guard_%d_" % (idx + 1)
			props.append({
				"name": p + "start",
				"type": TYPE_FLOAT,
				"usage": PROPERTY_USAGE_EDITOR,
				"hint": PROPERTY_HINT_NONE,
				"hint_string": "suffix:m",
			})
			props.append({
				"name": p + "end",
				"type": TYPE_FLOAT,
				"usage": PROPERTY_USAGE_EDITOR,
				"hint": PROPERTY_HINT_NONE,
				"hint_string": "suffix:m",
			})
	return props


func _set(property: StringName, value: Variant) -> bool:
	var parsed := _parse_guard_property(property)
	if parsed.is_empty():
		return false
	var guard: SideGuard = parsed["guard"]
	var side: SideGuardsAssembly.Side = parsed["side"]
	var origin: float = _get_side_extents(side)[0]
	var front: float = guard.position.x + guard.length / 2.0
	var back: float = guard.position.x - guard.length / 2.0
	var val: float = value
	match parsed["field"]:
		"end":
			front = val + origin
		"start":
			back = val + origin
	var new_length: float = max(0.01, front - back)
	var new_center: float = (front + back) / 2.0
	guard.length = new_length
	guard.position = Vector3(new_center, guard.position.y, guard.position.z)
	save_guard_state()
	return true


func _get(property: StringName) -> Variant:
	var parsed := _parse_guard_property(property)
	if parsed.is_empty():
		return null
	var guard: SideGuard = parsed["guard"]
	var side: SideGuardsAssembly.Side = parsed["side"]
	var origin: float = _get_side_extents(side)[0]
	match parsed["field"]:
		"end":
			return guard.position.x + guard.length / 2.0 - origin
		"start":
			return guard.position.x - guard.length / 2.0 - origin
	return null


func _get_side_data() -> Array[Dictionary]:
	return [
		{"side": Side.LEFT, "prefix": "left_side_guards_", "label": "Left Side Guards"},
		{"side": Side.RIGHT, "prefix": "right_side_guards_", "label": "Right Side Guards"},
	]


func _get_guards_for_side(side: SideGuardsAssembly.Side) -> Array[SideGuard]:
	var result: Array[SideGuard] = []
	var side_node := get_node_or_null(NodePath(_get_side_node_name(side))) as Node3D
	if not side_node:
		return result
	for child in side_node.get_children():
		if child is SideGuard:
			result.append(child)
	return result


func _parse_guard_property(property: StringName) -> Dictionary:
	var prop := str(property)
	for side_data in _get_side_data():
		var prefix: String = side_data["prefix"] + "guard_"
		if not prop.begins_with(prefix):
			continue
		var remainder: String = prop.substr(prefix.length())
		var sep := remainder.find("_")
		if sep < 0:
			return {}
		var idx := int(remainder.left(sep)) - 1
		var field: String = remainder.substr(sep + 1)
		if field not in ["start", "end"]:
			return {}
		var side: SideGuardsAssembly.Side = side_data["side"]
		var guards := _get_guards_for_side(side)
		if idx < 0 or idx >= guards.size():
			return {}
		return {"guard": guards[idx], "field": field, "side": side}
	return {}


func _check_guard_count_changed() -> void:
	var changed := false
	for side in [Side.LEFT, Side.RIGHT]:
		var count := _get_guards_for_side(side).size()
		if _last_guard_count.get(side, -1) != count:
			_last_guard_count[side] = count
			changed = true
	if changed:
		notify_property_list_changed()

#endregion
