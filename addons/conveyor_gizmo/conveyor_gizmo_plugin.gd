@tool
extends EditorNode3DGizmoPlugin

const HANDLE_SIZE = 0.1
const HANDLE_COLOR = Color(1, 0.5, 0, 1)
const HANDLE_COLOR_HOVER = Color(1, 0.8, 0, 1)

var _initial_state = {}
var sideguard_mode := false

func _get_gizmo_name():
	return "ConveyorGizmo"

func _has_gizmo(node):
	if not node is ResizableNode3D:
		return false

	var node_script = node.get_script()
	if node_script == null:
		return false

	var script_path = node_script.resource_path
	var valid_scripts = [
		"res://src/Conveyor/belt_conveyor.gd",
		"res://src/Conveyor/curved_belt_conveyor.gd",
		"res://src/RollerConveyor/roller_conveyor.gd",
		"res://parts/curved_roller_conveyor.gd",
		"res://src/ConveyorAssembly/belt_conveyor_assembly.gd",
		"res://src/ConveyorAssembly/roller_conveyor_assembly.gd",
		"res://src/ConveyorAssembly/spur_conveyor_assembly.gd",
		"res://src/ConveyorAssembly/belt_spur_conveyor_assembly.gd",
	]

	return script_path in valid_scripts

func _init():
	create_material("handles", HANDLE_COLOR)
	create_material("handles_hover", HANDLE_COLOR_HOVER)
	create_handle_material("handles", false)
	
	var handle_mat = get_material("handles", null)
	if handle_mat:
		handle_mat.vertex_color_use_as_albedo = true
		handle_mat.albedo_color = HANDLE_COLOR

func _redraw(gizmo: EditorNode3DGizmo):
	gizmo.clear()

	var node = gizmo.get_node_3d()

	if not node is ResizableNode3D:
		return

	var resizable_node = node as ResizableNode3D
	var size = resizable_node.size

	var handles = PackedVector3Array()
	var handle_ids = PackedInt32Array()

	var all_handles = [
		Vector3(size.x/2, 0, 0),
		Vector3(-size.x/2, 0, 0),
		Vector3(0, size.y/2, 0),
		Vector3(0, -size.y/2, 0),
		Vector3(0, 0, size.z/2),
		Vector3(0, 0, -size.z/2)
	]

	if not sideguard_mode:
		for i in range(all_handles.size()):
			handles.append(all_handles[i])
			handle_ids.append(i)

		if handles.size() > 0:
			gizmo.add_handles(handles, get_material("handles", gizmo), handle_ids)

	if sideguard_mode:
		# Add sideguard edge handles on the assembly level.
		# Handle IDs: 100=left front, 101=left back, 102=right front, 103=right back.
		var sg_guards := _get_all_guards(node)
		if not sg_guards.is_empty():
			var sg_handles := PackedVector3Array()
			var sg_ids := PackedInt32Array()
			for entry in sg_guards:
				var guard: SideGuard = entry["guard"]
				var side_node: Node3D = entry["side_node"]
				var front_x: float = guard.position.x + guard.length / 2.0
				var back_x: float = guard.position.x - guard.length / 2.0
				var y_mid: float = SideGuardMesh.WALL_HEIGHT / 2.0
				# Transform from side-node space to assembly space.
				var sg_assembly: Node3D = side_node.get_parent()
				var to_assembly: Transform3D = Transform3D.IDENTITY
				if sg_assembly:
					to_assembly = sg_assembly.transform
				var side_xform: Transform3D = to_assembly * side_node.transform
				sg_handles.append(side_xform * Vector3(front_x, y_mid, 0))
				sg_ids.append(entry["front_id"])
				sg_handles.append(side_xform * Vector3(back_x, y_mid, 0))
				sg_ids.append(entry["back_id"])
			gizmo.add_handles(sg_handles, get_material("handles", gizmo), sg_ids)

func _get_handle_name(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool):
	if handle_id >= 100:
		var guard_idx: int = (handle_id - 100) / 2
		var is_front := (handle_id % 2) == 0
		return "Guard %d %s" % [guard_idx + 1, "Front" if is_front else "Back"]
	var names = ["Size +X", "Size -X", "Size +Y", "Size -Y", "Size +Z", "Size -Z"]
	if handle_id >= 0 and handle_id < names.size():
		return names[handle_id]
	return ""

func _begin_handle_action(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool):
	var node = gizmo.get_node_3d()

	if handle_id >= 100:
		var guards := _get_all_guards(node)
		for entry in guards:
			if handle_id == entry["front_id"] or handle_id == entry["back_id"]:
				var guard: SideGuard = entry["guard"]
				var side_node: Node3D = entry["side_node"]
				var front_x: float = guard.position.x + guard.length / 2.0
				var back_x: float = guard.position.x - guard.length / 2.0

				# Shift+click: merge with adjacent guard.
				if Input.is_key_pressed(KEY_SHIFT):
					var is_front: bool = (handle_id == entry["front_id"])
					_try_merge_guards(node, guard, side_node, is_front)
					_initial_state = {"split": true}
					return

				# Ctrl+click: split guard at center.
				if Input.is_key_pressed(KEY_CTRL):
					_split_guard_at_center(node, guard, side_node)
					_initial_state = {"split": true}
					return

				_initial_state = {
					"guard": guard,
					"side_node": side_node,
					"length": guard.length,
					"position": guard.position,
					"front_x": front_x,
					"back_x": back_x,
				}
				break
		return

	if not node is ResizableNode3D:
		return

	var resizable_node = node as ResizableNode3D

	_initial_state = {
		"size": resizable_node.size,
		"position": node.position,
		"transform": node.transform,
		"rail_flags": _capture_rail_flags(node),
		"guard_flags": _capture_guard_flags(node),
	}


func _get_handle_value(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool):
	var node = gizmo.get_node_3d()
	if handle_id >= 100:
		for entry in _get_all_guards(node):
			if handle_id == entry["front_id"] or handle_id == entry["back_id"]:
				return (entry["guard"] as SideGuard).length
		return 0.0
	if not node is ResizableNode3D:
		return 0.0

	var resizable_node = node as ResizableNode3D
	var axis_index = int(handle_id / 2)

	return resizable_node.size[axis_index]

func _set_handle(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool, camera: Camera3D, point: Vector2):
	var node = gizmo.get_node_3d()

	if handle_id >= 100:
		if _initial_state.has("split"):
			return  # Split/merge already handled in _begin_handle_action.
		if _initial_state.has("guard"):
			var guard: SideGuard = _initial_state["guard"]
			var is_front := (handle_id % 2) == 0
			_set_side_guard_handle(guard, 100 if is_front else 101, camera, point)
			node.update_gizmos()
		return

	if not node is ResizableNode3D:
		return
	
	var resizable_node = node as ResizableNode3D
	
	var axis_index = int(handle_id / 2)
	var is_positive = (handle_id % 2) == 0
	
	var parent_transform = node.get_parent_node_3d().global_transform if node.get_parent_node_3d() else Transform3D.IDENTITY
	var initial_global_transform = parent_transform * _initial_state["transform"]
	var initial_size = _initial_state["size"]
	
	# Calculate the fixed edge (the one that shouldn't move)
	var fixed_edge_local = Vector3.ZERO
	fixed_edge_local[axis_index] = initial_size[axis_index] / 2.0 * (-1 if is_positive else 1)
	var fixed_edge_global = initial_global_transform * fixed_edge_local
	
	var axis_local = Vector3.ZERO
	axis_local[axis_index] = 1.0
	var axis_global = (initial_global_transform.basis * axis_local).normalized()
	
	var ray_from = camera.project_ray_origin(point)
	var ray_dir = camera.project_ray_normal(point)
	
	# Find closest point between mouse ray and resize axis
	var v1 = axis_global
	var v2 = ray_dir
	var v3 = fixed_edge_global - ray_from
	
	var dot11 = v1.dot(v1)
	var dot12 = v1.dot(v2)
	var dot13 = v1.dot(v3)
	var dot22 = v2.dot(v2)
	var dot23 = v2.dot(v3)
	
	var denom = dot11 * dot22 - dot12 * dot12
	if abs(denom) < 0.0001:
		return
	
	var t1 = (dot12 * dot23 - dot22 * dot13) / denom
	var distance_along_axis = t1
	
	var new_size = initial_size
	new_size[axis_index] = abs(distance_along_axis)
	
	new_size[axis_index] = max(new_size[axis_index], resizable_node.size_min[axis_index])
	
	var actual_distance = new_size[axis_index] * (1 if distance_along_axis >= 0 else -1)
	var center_global = fixed_edge_global + axis_global * (actual_distance / 2.0)
	var new_position = parent_transform.affine_inverse() * center_global
	
	node.position = new_position
	resizable_node.resize(new_size, handle_id)

func _commit_handle(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool, restore, cancel: bool):
	var node = gizmo.get_node_3d()

	if handle_id >= 100 and _initial_state.has("split"):
		_initial_state.clear()
		return

	if handle_id >= 100 and _initial_state.has("guard"):
		var guard: SideGuard = _initial_state["guard"]
		if cancel:
			guard.length = _initial_state["length"]
			guard.position = _initial_state["position"]
		else:
			# Mark the dragged edge as no longer anchored to the conveyor edge.
			var is_front := (handle_id % 2) == 0
			var undo_redo = EditorInterface.get_editor_undo_redo()
			undo_redo.create_action("Resize Side Guard")
			undo_redo.add_do_property(guard, "length", guard.length)
			undo_redo.add_do_property(guard, "position", guard.position)
			if is_front:
				undo_redo.add_do_property(guard, "front_anchored", false)
				undo_redo.add_undo_property(guard, "front_anchored", true)
			else:
				undo_redo.add_do_property(guard, "back_anchored", false)
				undo_redo.add_undo_property(guard, "back_anchored", true)
			undo_redo.add_undo_property(guard, "length", _initial_state["length"])
			undo_redo.add_undo_property(guard, "position", _initial_state["position"])
			var sg_assembly: Node = _initial_state["side_node"].get_parent()
			if sg_assembly and sg_assembly.has_method("save_guard_state"):
				undo_redo.add_do_method(sg_assembly, "save_guard_state")
				undo_redo.add_undo_method(sg_assembly, "save_guard_state")
			undo_redo.add_do_method(node, "update_gizmos")
			undo_redo.add_undo_method(node, "update_gizmos")
			undo_redo.commit_action()
		_initial_state.clear()
		return

	if not node is ResizableNode3D:
		return

	var resizable_node = node as ResizableNode3D

	if cancel:
		node.position = _initial_state["position"]
		resizable_node.size = _initial_state["size"]
		_restore_rail_flags(node, _initial_state["rail_flags"])
		_restore_guard_flags(node, _initial_state["guard_flags"])
	else:
		var undo_redo = EditorInterface.get_editor_undo_redo()
		undo_redo.create_action("Resize Conveyor")
		# Position must be set before size so the side-guard update chain
		# sees the correct global transform (matches _set_handle order).
		undo_redo.add_do_property(node, "position", node.position)
		undo_redo.add_do_property(resizable_node, "size", resizable_node.size)
		undo_redo.add_do_method(self, "_restore_rail_flags", node, _capture_rail_flags(node))
		undo_redo.add_do_method(self, "_restore_guard_flags", node, _capture_guard_flags(node))
		# Position/size first (triggers _on_size_changed), then restore overrides the result.
		undo_redo.add_undo_property(node, "position", _initial_state["position"])
		undo_redo.add_undo_property(resizable_node, "size", _initial_state["size"])
		undo_redo.add_undo_method(self, "_restore_rail_flags", node, _initial_state["rail_flags"])
		undo_redo.add_undo_method(self, "_restore_guard_flags", node, _initial_state["guard_flags"])
		var sg_assembly: Node = _find_side_guards_assembly(node)
		if sg_assembly:
			undo_redo.add_do_method(sg_assembly, "save_guard_state")
			undo_redo.add_undo_method(sg_assembly, "save_guard_state")
		undo_redo.commit_action()

	_initial_state.clear()


## Drag a SideGuard handle in side-node space (no 180° rotation issues).
func _set_side_guard_handle(_guard: SideGuard, handle_id: int, camera: Camera3D, point: Vector2) -> void:
	var is_front := (handle_id % 2) == 0
	var guard: SideGuard = _initial_state["guard"]
	var side_node: Node3D = _initial_state["side_node"]

	# Fixed edge in side-node space.
	var fixed_x: float = _initial_state["back_x"] if is_front else _initial_state["front_x"]
	var side_global: Transform3D = side_node.global_transform
	var fixed_edge_global: Vector3 = side_global * Vector3(fixed_x, 0, 0)

	var axis_global: Vector3 = (side_global.basis.x).normalized()

	var ray_from := camera.project_ray_origin(point)
	var ray_dir := camera.project_ray_normal(point)

	var v1 := axis_global
	var v2 := ray_dir
	var v3 := fixed_edge_global - ray_from

	var dot11 := v1.dot(v1)
	var dot12 := v1.dot(v2)
	var dot13 := v1.dot(v3)
	var dot22 := v2.dot(v2)
	var dot23 := v2.dot(v3)

	var denom := dot11 * dot22 - dot12 * dot12
	if abs(denom) < 0.0001:
		return

	var t1: float = (dot12 * dot23 - dot22 * dot13) / denom

	# Compute new extents in side-node space.
	var new_front_x: float
	var new_back_x: float
	if is_front:
		new_back_x = fixed_x
		new_front_x = fixed_x + t1
		if new_front_x < new_back_x + 0.01:
			new_front_x = new_back_x + 0.01
	else:
		new_front_x = fixed_x
		new_back_x = fixed_x + t1
		if new_back_x > new_front_x - 0.01:
			new_back_x = new_front_x - 0.01

	var new_length: float = new_front_x - new_back_x
	var new_center_x: float = (new_front_x + new_back_x) / 2.0
	guard.position = Vector3(new_center_x, guard.position.y, guard.position.z)
	guard.length = new_length


## Try to merge this guard with an adjacent guard across a gap.
## Returns true if a merge was performed, false if no adjacent guard found.
func _try_merge_guards(conveyor_node: Node3D, guard: SideGuard, side_node: Node3D, is_front: bool) -> bool:
	var guard_front: float = guard.position.x + guard.length / 2.0
	var guard_back: float = guard.position.x - guard.length / 2.0
	var edge_x: float = guard_front if is_front else guard_back

	# Find the nearest guard in the correct direction across the gap.
	# If clicking the front handle, look for guards ahead (+X).
	# If clicking the back handle, look for guards behind (-X).
	var nearest: SideGuard = null
	var nearest_dist := INF
	for child in side_node.get_children():
		if not child is SideGuard or child == guard:
			continue
		var other := child as SideGuard
		var other_front: float = other.position.x + other.length / 2.0
		var other_back: float = other.position.x - other.length / 2.0

		# The other guard's facing edge must be in the right direction.
		var other_edge: float = other_back if is_front else other_front
		var direction_ok: bool
		if is_front:
			direction_ok = other_edge > edge_x - 0.01  # Other is ahead
		else:
			direction_ok = other_edge < edge_x + 0.01  # Other is behind

		if not direction_ok:
			continue

		var dist: float = abs(other_edge - edge_x)
		if dist < nearest_dist:
			nearest_dist = dist
			nearest = other

	if not nearest:
		# No adjacent guard — re-anchor this edge to the conveyor boundary if it's unanchored.
		return _try_reanchor_guard(conveyor_node, guard, side_node, is_front)

	# Merge: extend this guard to cover both, remove the other.
	var other_front: float = nearest.position.x + nearest.length / 2.0
	var other_back: float = nearest.position.x - nearest.length / 2.0
	var merged_front: float = max(guard_front, other_front)
	var merged_back: float = min(guard_back, other_back)
	var merged_length: float = merged_front - merged_back
	var merged_center: float = (merged_front + merged_back) / 2.0

	var old_length: float = guard.length
	var old_pos: Vector3 = guard.position

	var sg_assembly: Node = side_node.get_parent()
	var undo_redo := EditorInterface.get_editor_undo_redo()
	undo_redo.create_action("Merge Side Guards")

	# Expand this guard to cover the merged area.
	undo_redo.add_do_property(guard, "length", merged_length)
	undo_redo.add_do_property(guard, "position", Vector3(merged_center, 0, 0))
	undo_redo.add_do_property(guard, "front_anchored", guard.front_anchored or nearest.front_anchored)
	undo_redo.add_do_property(guard, "back_anchored", guard.back_anchored or nearest.back_anchored)
	undo_redo.add_undo_property(guard, "length", old_length)
	undo_redo.add_undo_property(guard, "position", old_pos)
	undo_redo.add_undo_property(guard, "front_anchored", guard.front_anchored)
	undo_redo.add_undo_property(guard, "back_anchored", guard.back_anchored)

	# Remove the other guard.
	undo_redo.add_do_method(side_node, "remove_child", nearest)
	undo_redo.add_undo_method(side_node, "add_child", nearest)
	undo_redo.add_undo_reference(nearest)
	if sg_assembly and sg_assembly.has_method("save_guard_state"):
		undo_redo.add_do_method(sg_assembly, "save_guard_state")
		undo_redo.add_undo_method(sg_assembly, "save_guard_state")
	undo_redo.add_do_method(conveyor_node, "update_gizmos")
	undo_redo.add_undo_method(conveyor_node, "update_gizmos")

	undo_redo.commit_action()
	return true


## Re-anchor a guard's edge to the conveyor boundary.
## Called when shift+clicking a handle with no adjacent guard to merge with.
## Returns true if the edge was re-anchored, false if it was already anchored.
func _try_reanchor_guard(conveyor_node: Node3D, guard: SideGuard, side_node: Node3D, is_front: bool) -> bool:
	var already_anchored: bool = guard.front_anchored if is_front else guard.back_anchored
	if already_anchored:
		return false

	var sg_assembly: Node = side_node.get_parent()
	if not sg_assembly or not sg_assembly.has_method("_get_side_extents"):
		return false

	var side: SideGuardsAssembly.Side = SideGuardsAssembly.Side.RIGHT
	if side_node.name == "LeftSide":
		side = SideGuardsAssembly.Side.LEFT

	var extents: Array[float] = sg_assembly._get_side_extents(side)
	var boundary: float = extents[1] if is_front else extents[0]

	var guard_front: float = guard.position.x + guard.length / 2.0
	var guard_back: float = guard.position.x - guard.length / 2.0
	var old_length: float = guard.length
	var old_pos: Vector3 = guard.position

	var new_front: float = boundary if is_front else guard_front
	var new_back: float = guard_back if is_front else boundary
	var new_length: float = max(0.01, new_front - new_back)
	var new_center: float = (new_front + new_back) / 2.0

	var undo_redo := EditorInterface.get_editor_undo_redo()
	undo_redo.create_action("Re-anchor Side Guard")
	undo_redo.add_do_property(guard, "length", new_length)
	undo_redo.add_do_property(guard, "position", Vector3(new_center, 0, 0))
	if is_front:
		undo_redo.add_do_property(guard, "front_anchored", true)
		undo_redo.add_undo_property(guard, "front_anchored", false)
	else:
		undo_redo.add_do_property(guard, "back_anchored", true)
		undo_redo.add_undo_property(guard, "back_anchored", false)
	undo_redo.add_undo_property(guard, "length", old_length)
	undo_redo.add_undo_property(guard, "position", old_pos)
	if sg_assembly.has_method("save_guard_state"):
		undo_redo.add_do_method(sg_assembly, "save_guard_state")
		undo_redo.add_undo_method(sg_assembly, "save_guard_state")
	undo_redo.add_do_method(conveyor_node, "update_gizmos")
	undo_redo.add_undo_method(conveyor_node, "update_gizmos")
	undo_redo.commit_action()
	return true


## Split a guard into two halves with a small gap at the center.
## Creates an undo/redo action and saves guard state.
func _split_guard_at_center(conveyor_node: Node3D, guard: SideGuard, side_node: Node3D) -> void:
	const GAP := 0.15  # Gap size in meters at the split point.
	var old_length: float = guard.length
	var old_pos: Vector3 = guard.position
	var g_front: float = guard.position.x + old_length / 2.0
	var g_back: float = guard.position.x - old_length / 2.0
	var mid: float = guard.position.x

	if old_length < GAP + 0.02:
		return  # Guard too short to split.

	# Back half: from g_back to mid - gap/2.
	var back_front: float = mid - GAP / 2.0
	var back_length: float = back_front - g_back
	var back_center: float = (g_back + back_front) / 2.0

	# Front half: from mid + gap/2 to g_front.
	var front_back: float = mid + GAP / 2.0
	var front_length: float = g_front - front_back
	var front_center: float = (front_back + g_front) / 2.0

	# Determine side for basis.
	var guard_basis := Basis.IDENTITY
	if side_node.name == "RightSide":
		guard_basis = Basis(Vector3.UP, PI)

	var sg_assembly: Node = side_node.get_parent()

	var undo_redo := EditorInterface.get_editor_undo_redo()
	undo_redo.create_action("Split Side Guard")

	# Shrink original guard to back half.
	undo_redo.add_do_property(guard, "length", back_length)
	undo_redo.add_do_property(guard, "position", Vector3(back_center, 0, 0))
	undo_redo.add_do_property(guard, "front_anchored", false)
	undo_redo.add_undo_property(guard, "length", old_length)
	undo_redo.add_undo_property(guard, "position", old_pos)
	undo_redo.add_undo_property(guard, "front_anchored", guard.front_anchored)

	# Create new guard for front half.
	var new_guard: SideGuard = sg_assembly._instantiate_guard()
	new_guard.back_anchored = false
	new_guard.front_anchored = guard.front_anchored
	new_guard.transform = Transform3D(guard_basis, Vector3(front_center, 0, 0))
	new_guard.length = front_length
	undo_redo.add_do_method(side_node, "add_child", new_guard)
	undo_redo.add_do_reference(new_guard)
	undo_redo.add_undo_method(side_node, "remove_child", new_guard)
	if sg_assembly and sg_assembly.has_method("save_guard_state"):
		undo_redo.add_do_method(sg_assembly, "save_guard_state")
		undo_redo.add_undo_method(sg_assembly, "save_guard_state")
	undo_redo.add_do_method(conveyor_node, "update_gizmos")
	undo_redo.add_undo_method(conveyor_node, "update_gizmos")

	undo_redo.commit_action()


## Capture anchoring flags from all FrameRails under a node.
## Uses node path instead of object reference for undo/redo safety.
func _capture_rail_flags(node: Node) -> Array:
	var result: Array = []
	_collect_rail_flags(node, node, result)
	return result


static func _collect_rail_flags(root: Node, node: Node, result: Array) -> void:
	if node is FrameRail:
		var rail := node as FrameRail
		result.append({
			"path": str(root.get_path_to(rail)),
			"position": rail.position,
			"length": rail.length,
			"front_anchored": rail.front_anchored,
			"back_anchored": rail.back_anchored,
			"front_boundary_tracking": rail.front_boundary_tracking,
			"back_boundary_tracking": rail.back_boundary_tracking,
		})
	for child in node.get_children():
		_collect_rail_flags(root, child, result)


## Restore previously captured FrameRail state.
func _restore_rail_flags(node: Node, flags: Array) -> void:
	for entry in flags:
		var rail := node.get_node_or_null(entry["path"]) as FrameRail
		if not rail:
			continue
		rail.position = entry["position"]
		rail.length = entry["length"]
		rail.front_anchored = entry["front_anchored"]
		rail.back_anchored = entry["back_anchored"]
		rail.front_boundary_tracking = entry["front_boundary_tracking"]
		rail.back_boundary_tracking = entry["back_boundary_tracking"]


## Capture anchoring flags from all SideGuards under a node.
func _capture_guard_flags(node: Node3D) -> Array:
	var result: Array = []
	var sg: Node = _find_side_guards_assembly(node)
	if not sg:
		return result
	for side_name in ["LeftSide", "RightSide"]:
		var side_node := sg.get_node_or_null(side_name) as Node3D
		if not side_node:
			continue
		var idx := 0
		for child in side_node.get_children():
			if child is SideGuard:
				var guard := child as SideGuard
				result.append({
					"side": side_name,
					"index": idx,
					"position": guard.position,
					"length": guard.length,
					"front_anchored": guard.front_anchored,
					"back_anchored": guard.back_anchored,
					"front_boundary_tracking": guard.front_boundary_tracking,
					"back_boundary_tracking": guard.back_boundary_tracking,
				})
				idx += 1
	return result


## Restore previously captured SideGuard anchoring flags.
func _restore_guard_flags(node: Node3D, flags: Array) -> void:
	var sg: Node = _find_side_guards_assembly(node)
	if not sg:
		return
	for entry in flags:
		var side_node := sg.get_node_or_null(entry["side"]) as Node3D
		if not side_node:
			continue
		var idx := 0
		for child in side_node.get_children():
			if child is SideGuard:
				if idx == entry["index"]:
					child.position = entry["position"]
					child.length = entry["length"]
					child.front_anchored = entry["front_anchored"]
					child.back_anchored = entry["back_anchored"]
					child.front_boundary_tracking = entry["front_boundary_tracking"]
					child.back_boundary_tracking = entry["back_boundary_tracking"]
					break
				idx += 1


## Find the SideGuardsAssembly node on a conveyor assembly, or null.
func _find_side_guards_assembly(node: Node3D) -> Node:
	for path in ["%SideGuardsAssembly", "Conveyor/SideGuardsAssembly", "%Conveyor/%SideGuardsAssembly"]:
		var sg := node.get_node_or_null(path)
		if sg:
			return sg
	return null


## Find all SideGuard nodes on a conveyor assembly.
## Returns array of {"guard": SideGuard, "side_node": Node3D, "front_id": int, "back_id": int}.
## Handle IDs are assigned sequentially starting at 100: 100/101 for first guard, 102/103 for second, etc.
func _get_all_guards(node: Node3D) -> Array:
	var result: Array = []
	var sg_assembly: Node = _find_side_guards_assembly(node)
	if not sg_assembly:
		return result

	var handle_idx := 100
	for side_name in ["LeftSide", "RightSide"]:
		var side_node := sg_assembly.get_node_or_null(side_name) as Node3D
		if not side_node:
			continue
		for child in side_node.get_children():
			if child is SideGuard:
				result.append({
					"guard": child as SideGuard,
					"side_node": side_node,
					"front_id": handle_idx,
					"back_id": handle_idx + 1,
				})
				handle_idx += 2
	return result
