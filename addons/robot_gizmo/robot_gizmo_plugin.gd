@tool
extends EditorNode3DGizmoPlugin

const JOINT_COLORS = [
	Color(1.0, 0.2, 0.2),
	Color(1.0, 0.6, 0.2),
	Color(1.0, 1.0, 0.2),
	Color(0.2, 1.0, 0.2),
	Color(0.2, 0.6, 1.0),
	Color(0.8, 0.2, 1.0),
]

const ARC_SEGMENTS = 32
const ARC_RADIUS_SCALE = 1.5

var _drag_joint_idx: int = -1
var _initial_joint_angle: float = 0.0
var _drag_start_mouse_angle: float = 0.0
var _pivot_screen_pos: Vector2 = Vector2.ZERO


func _get_gizmo_name() -> String:
	return "RobotJointGizmo"


func _has_gizmo(node: Node3D) -> bool:
	if node.get_script() == null:
		return false
	var script_path = node.get_script().resource_path
	return script_path == "res://src/SixAxisRobot/six_axis_robot.gd"


func _init() -> void:
	for i in range(6):
		create_material("joint_%d" % i, JOINT_COLORS[i])
		var mat = get_material("joint_%d" % i, null)
		if mat:
			mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
			mat.no_depth_test = true
			mat.render_priority = 10
	
	create_handle_material("handles", false)


func _redraw(gizmo: EditorNode3DGizmo) -> void:
	gizmo.clear()
	
	var node = gizmo.get_node_3d()
	if node == null:
		return
	
	if not node.get("show_gizmos"):
		return
	
	var pivots = [
		node.get("_base_pivot"),
		node.get("_upper_arm_pivot"),
		node.get("_forearm_pivot"),
		node.get("_wrist_rot_pivot"),
		node.get("_wrist_pitch_pivot"),
		node.get("_tool_pivot"),
	]
	
	var robot_scale: float = node.get("robot_scale") if node.get("robot_scale") else 3.0
	
	var all_handles = PackedVector3Array()
	var all_handle_ids = PackedInt32Array()
	
	for i in range(6):
		var pivot = pivots[i]
		if pivot == null:
			continue
		
		var arc_radius: float = _get_arc_radius(i, robot_scale)
		var arc_data := _generate_arc_with_handle(i, pivot, node, arc_radius)
		
		if arc_data.lines.size() > 0:
			gizmo.add_lines(arc_data.lines, get_material("joint_%d" % i, gizmo), false)
		
		all_handles.append(arc_data.handle_pos)
		all_handle_ids.append(i)
	
	if all_handles.size() > 0:
		gizmo.add_handles(all_handles, get_material("handles", gizmo), all_handle_ids)


func _get_arc_radius(joint_idx: int, robot_scale: float) -> float:
	var base_radii = [0.25, 0.2, 0.15, 0.12, 0.1, 0.08]
	return base_radii[joint_idx] * robot_scale * ARC_RADIUS_SCALE


func _generate_arc_with_handle(joint_idx: int, pivot: Node3D, robot: Node3D, radius: float) -> Dictionary:
	var lines = PackedVector3Array()
	var handle_pos = Vector3.ZERO
	var is_y_axis = joint_idx in [0, 3, 5]
	
	var pivot_pos = robot.to_local(pivot.global_position)
	var pivot_basis = robot.global_transform.affine_inverse().basis * pivot.global_transform.basis
	
	var axis: Vector3
	var perp1: Vector3
	var perp2: Vector3
	
	if is_y_axis:
		axis = pivot_basis.y.normalized()
		perp1 = pivot_basis.x.normalized()
		perp2 = pivot_basis.z.normalized()
	else:
		axis = pivot_basis.z.normalized()
		perp1 = pivot_basis.x.normalized()
		perp2 = pivot_basis.y.normalized()
	
	for i in range(ARC_SEGMENTS):
		var t1 = (float(i) / ARC_SEGMENTS) * TAU
		var t2 = (float(i + 1) / ARC_SEGMENTS) * TAU
		
		var p1 = pivot_pos + (perp1 * cos(t1) + perp2 * sin(t1)) * radius
		var p2 = pivot_pos + (perp1 * cos(t2) + perp2 * sin(t2)) * radius
		
		lines.append(p1)
		lines.append(p2)
	
	handle_pos = pivot_pos + perp1 * radius
	var cross_size = radius * 0.3
	lines.append(handle_pos - perp1 * cross_size)
	lines.append(handle_pos + perp1 * cross_size)
	lines.append(handle_pos - perp2 * cross_size)
	lines.append(handle_pos + perp2 * cross_size)
	
	lines.append(pivot_pos)
	lines.append(handle_pos)
	
	return {"lines": lines, "handle_pos": handle_pos}


func _get_handle_name(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool) -> String:
	return "J%d" % (handle_id + 1)


func _get_handle_value(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool) -> Variant:
	var node = gizmo.get_node_3d()
	if node == null:
		return 0.0
	
	var angle_props = ["j1_angle", "j2_angle", "j3_angle", "j4_angle", "j5_angle", "j6_angle"]
	return node.get(angle_props[handle_id])


func _begin_handle_action(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool) -> void:
	var node = gizmo.get_node_3d()
	if node == null:
		return
	
	_drag_joint_idx = handle_id
	var angle_props = ["j1_angle", "j2_angle", "j3_angle", "j4_angle", "j5_angle", "j6_angle"]
	_initial_joint_angle = node.get(angle_props[handle_id])
	_drag_start_mouse_angle = -999.0
	_pivot_screen_pos = Vector2.ZERO


func _set_handle(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool, camera: Camera3D, screen_pos: Vector2) -> void:
	var node = gizmo.get_node_3d()
	if node == null:
		return
	
	var pivots = [
		node.get("_base_pivot"),
		node.get("_upper_arm_pivot"),
		node.get("_forearm_pivot"),
		node.get("_wrist_rot_pivot"),
		node.get("_wrist_pitch_pivot"),
		node.get("_tool_pivot"),
	]
	
	var pivot = pivots[handle_id]
	if pivot == null:
		return
	
	if _pivot_screen_pos == Vector2.ZERO:
		_pivot_screen_pos = camera.unproject_position(pivot.global_position)
	
	var to_mouse = screen_pos - _pivot_screen_pos
	var mouse_angle = atan2(to_mouse.y, to_mouse.x)
	
	if _drag_start_mouse_angle < -900.0:
		_drag_start_mouse_angle = mouse_angle
		return
	
	var delta_angle = rad_to_deg(mouse_angle - _drag_start_mouse_angle)
	var is_y_axis = handle_id in [0, 3, 5]
	var joint_axis: Vector3
	if is_y_axis:
		joint_axis = pivot.global_transform.basis.y.normalized()
	else:
		joint_axis = pivot.global_transform.basis.z.normalized()
	
	var camera_forward = -camera.global_transform.basis.z.normalized()
	var axis_dot = joint_axis.dot(camera_forward)
	if axis_dot < 0:
		delta_angle = -delta_angle
	
	var new_angle = _initial_joint_angle + delta_angle
	
	var angle_props = ["j1_angle", "j2_angle", "j3_angle", "j4_angle", "j5_angle", "j6_angle"]
	node.set(angle_props[handle_id], new_angle)
	
	node.update_gizmos()


func _commit_handle(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool, restore: Variant, cancel: bool) -> void:
	var node = gizmo.get_node_3d()
	if node == null:
		return
	
	var angle_props = ["j1_angle", "j2_angle", "j3_angle", "j4_angle", "j5_angle", "j6_angle"]
	
	if cancel:
		node.set(angle_props[handle_id], _initial_joint_angle)
	else:
		var undo_redo = EditorInterface.get_editor_undo_redo()
		undo_redo.create_action("Rotate Robot J%d" % (handle_id + 1))
		undo_redo.add_do_property(node, angle_props[handle_id], node.get(angle_props[handle_id]))
		undo_redo.add_undo_property(node, angle_props[handle_id], _initial_joint_angle)
		undo_redo.commit_action()
	
	_drag_joint_idx = -1
	_drag_start_mouse_angle = 0.0
	_pivot_screen_pos = Vector2.ZERO
	
	if node:
		node.update_gizmos()
