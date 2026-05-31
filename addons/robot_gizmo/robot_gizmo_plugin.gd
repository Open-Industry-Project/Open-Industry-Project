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
const EE_COLOR = Color(0.2, 0.9, 0.9)
const EE_SUBGIZMO_ID = 0

const EOAT_HANDLE_POS_X = 10
const EOAT_HANDLE_NEG_X = 11
const EOAT_HANDLE_POS_Z = 12
const EOAT_HANDLE_NEG_Z = 13
const EOAT_FOAM_SUBGIZMO_ID = 1

var _drag_joint_idx: int = -1
var _initial_joint_angle: float = 0.0
var _drag_start_mouse_angle: float = 0.0
var _pivot_screen_pos: Vector2 = Vector2.ZERO

var _initial_joint_angles: Array = []

var _eoat_mode: bool = false
var _eoat_initial_length: float = 0.0
var _eoat_initial_width: float = 0.0


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
	
	create_material("ee_line", EE_COLOR)
	var ee_mat = get_material("ee_line", null)
	if ee_mat:
		ee_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		ee_mat.no_depth_test = true
		ee_mat.render_priority = 10


func _redraw(gizmo: EditorNode3DGizmo) -> void:
	gizmo.clear()

	var node = gizmo.get_node_3d()
	if node == null:
		return

	if not node.get("show_gizmos"):
		return

	if not EditorInterface.get_selection().get_selected_nodes().has(node):
		_eoat_mode = false
		return

	if not _eoat_mode:
		var pivots = [
			node.get("_base_pivot"), node.get("_upper_arm_pivot"),
			node.get("_forearm_pivot"), node.get("_wrist_rot_pivot"),
			node.get("_wrist_pitch_pivot"), node.get("_tool_pivot"),
		]
		var robot_scale: float = node.get("robot_scale") if node.get("robot_scale") else 3.0
		var all_handles := PackedVector3Array()
		var all_handle_ids := PackedInt32Array()
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
		var tip_global: Vector3 = node.call("get_tool_tip_position")
		var tip_local: Vector3 = node.to_local(tip_global)
		var ee_lines := PackedVector3Array()
		var cross_size: float = 0.08 * robot_scale
		ee_lines.append(tip_local + Vector3(-cross_size, 0, 0))
		ee_lines.append(tip_local + Vector3(cross_size, 0, 0))
		ee_lines.append(tip_local + Vector3(0, -cross_size, 0))
		ee_lines.append(tip_local + Vector3(0, cross_size, 0))
		ee_lines.append(tip_local + Vector3(0, 0, -cross_size))
		ee_lines.append(tip_local + Vector3(0, 0, cross_size))
		gizmo.add_lines(ee_lines, get_material("ee_line", gizmo), false)
	else:
		var cup_mesh: MeshInstance3D = node.get("_vacuum_cup_mesh")
		if cup_mesh:
			var eoat_length: float = node.get("eoat_length")
			var eoat_width: float = node.get("eoat_width")
			var c: Vector3 = node.to_local(cup_mesh.global_position)
			var b: Basis = node.global_transform.affine_inverse().basis * cup_mesh.global_transform.basis
			var ax: Vector3 = b.x.normalized()
			var ay: Vector3 = b.y.normalized()
			var az: Vector3 = b.z.normalized()
			var hx: float = eoat_length * 0.5
			var hy: float = 0.04
			var hz: float = eoat_width * 0.5
			var corners: Array[Vector3] = [
				c + ax*hx + ay*hy + az*hz, c + ax*hx + ay*hy - az*hz,
				c + ax*hx - ay*hy + az*hz, c + ax*hx - ay*hy - az*hz,
				c - ax*hx + ay*hy + az*hz, c - ax*hx + ay*hy - az*hz,
				c - ax*hx - ay*hy + az*hz, c - ax*hx - ay*hy - az*hz,
			]
			var box_lines := PackedVector3Array()
			for edge: Array in [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]]:
				box_lines.append(corners[edge[0]])
				box_lines.append(corners[edge[1]])
			gizmo.add_lines(box_lines, get_material("ee_line", gizmo), false)
			var eoat_handles := PackedVector3Array()
			eoat_handles.append(c + ax * hx)
			eoat_handles.append(c - ax * hx)
			eoat_handles.append(c + az * hz)
			eoat_handles.append(c - az * hz)
			gizmo.add_handles(eoat_handles, get_material("handles", gizmo),
					PackedInt32Array([EOAT_HANDLE_POS_X, EOAT_HANDLE_NEG_X, EOAT_HANDLE_POS_Z, EOAT_HANDLE_NEG_Z]))


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
	if handle_id < 10:
		return "J%d" % (handle_id + 1)
	match handle_id:
		EOAT_HANDLE_POS_X: return "EOAT Width +X"
		EOAT_HANDLE_NEG_X: return "EOAT Width -X"
		EOAT_HANDLE_POS_Z: return "EOAT Depth +Z"
		EOAT_HANDLE_NEG_Z: return "EOAT Depth -Z"
	return ""


func _get_handle_value(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool) -> Variant:
	var node = gizmo.get_node_3d()
	if node == null:
		return 0.0
	if handle_id >= 10:
		if handle_id in [EOAT_HANDLE_POS_X, EOAT_HANDLE_NEG_X]:
			return node.get("eoat_length")
		return node.get("eoat_width")
	var angle_props = ["j1_angle", "j2_angle", "j3_angle", "j4_angle", "j5_angle", "j6_angle"]
	return node.get(angle_props[handle_id])


func _begin_handle_action(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool) -> void:
	var node = gizmo.get_node_3d()
	if node == null:
		return
	if handle_id >= 10:
		_eoat_initial_length = node.get("eoat_length")
		_eoat_initial_width = node.get("eoat_width")
		return
	if _eoat_mode:
		_eoat_mode = false
		node.update_gizmos()
	_drag_joint_idx = handle_id
	var angle_props = ["j1_angle", "j2_angle", "j3_angle", "j4_angle", "j5_angle", "j6_angle"]
	_initial_joint_angle = node.get(angle_props[handle_id])
	_drag_start_mouse_angle = -999.0
	_pivot_screen_pos = Vector2.ZERO


func _set_handle(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool, camera: Camera3D, screen_pos: Vector2) -> void:
	var node = gizmo.get_node_3d()
	if node == null:
		return

	if handle_id >= 10:
		var cup_mesh: MeshInstance3D = node.get("_vacuum_cup_mesh")
		if cup_mesh == null:
			return
		var center_world := cup_mesh.global_position
		var xform := cup_mesh.global_transform
		var axis_world: Vector3
		match handle_id:
			EOAT_HANDLE_POS_X: axis_world = xform.basis.x.normalized()
			EOAT_HANDLE_NEG_X: axis_world = -xform.basis.x.normalized()
			EOAT_HANDLE_POS_Z: axis_world = xform.basis.z.normalized()
			EOAT_HANDLE_NEG_Z: axis_world = -xform.basis.z.normalized()
		var new_dim: float = maxf(0.1, _ray_to_axis_t(center_world, axis_world, camera.global_position, camera.project_ray_normal(screen_pos)) * 2.0)
		if handle_id in [EOAT_HANDLE_POS_X, EOAT_HANDLE_NEG_X]:
			node.set("eoat_length", new_dim)
		else:
			node.set("eoat_width", new_dim)
		node.update_gizmos()
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

	if handle_id >= 10:
		if cancel:
			node.set("eoat_length", _eoat_initial_length)
			node.set("eoat_width", _eoat_initial_width)
		else:
			var undo_redo := EditorInterface.get_editor_undo_redo()
			undo_redo.create_action("Resize EOAT")
			undo_redo.add_do_property(node, "eoat_length", node.get("eoat_length"))
			undo_redo.add_do_property(node, "eoat_width", node.get("eoat_width"))
			undo_redo.add_undo_property(node, "eoat_length", _eoat_initial_length)
			undo_redo.add_undo_property(node, "eoat_width", _eoat_initial_width)
			undo_redo.commit_action()
		node.update_gizmos()
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


func _subgizmos_intersect_ray(gizmo: EditorNode3DGizmo, camera: Camera3D, point: Vector2) -> int:
	var node = gizmo.get_node_3d()
	if node == null or not node.get("show_gizmos"):
		return -1

	# Foam pad takes priority — IK tip sits on the pad face so must be checked first
	var cup_mesh: MeshInstance3D = node.get("_vacuum_cup_mesh")
	if cup_mesh:
		var eoat_length: float = node.get("eoat_length")
		var eoat_width: float = node.get("eoat_width")
		var ray_o := camera.global_position
		var ray_d := camera.project_ray_normal(point)
		var hit := _ray_hits_foam_pad(ray_o, ray_d, cup_mesh, eoat_length, eoat_width)
		if hit:
			_eoat_mode = true
			_initial_joint_angles = Array(node.call("get_joint_angles"))
			node.update_gizmos()
			return EOAT_FOAM_SUBGIZMO_ID

	var tip_global: Vector3 = node.call("get_tool_tip_position")
	var tip_screen := camera.unproject_position(tip_global)
	if tip_screen.distance_to(point) < 20.0:
		_initial_joint_angles = Array(node.call("get_joint_angles"))
		if _eoat_mode:
			_eoat_mode = false
			node.update_gizmos()
		return EE_SUBGIZMO_ID

	if _eoat_mode:
		_eoat_mode = false
		node.update_gizmos()
	return -1


func _subgizmos_intersect_frustum(gizmo: EditorNode3DGizmo, camera: Camera3D, frustum: Array[Plane]) -> PackedInt32Array:
	var node = gizmo.get_node_3d()
	if node == null or not node.get("show_gizmos"):
		return PackedInt32Array()

	var tip_global: Vector3 = node.call("get_tool_tip_position")
	for plane: Plane in frustum:
		if not plane.is_point_over(tip_global):
			return PackedInt32Array()

	_initial_joint_angles = Array(node.call("get_joint_angles"))
	return PackedInt32Array([EE_SUBGIZMO_ID])


func _get_subgizmo_transform(gizmo: EditorNode3DGizmo, subgizmo_id: int) -> Transform3D:
	var node = gizmo.get_node_3d()
	if node == null:
		return Transform3D()
	if subgizmo_id == EOAT_FOAM_SUBGIZMO_ID:
		var cup_mesh: MeshInstance3D = node.get("_vacuum_cup_mesh")
		if cup_mesh:
			return node.global_transform.affine_inverse() * cup_mesh.global_transform
		return Transform3D()
	var tip_global: Transform3D = node.call("get_tool_tip_transform")
	return node.global_transform.affine_inverse() * tip_global


func _set_subgizmo_transform(gizmo: EditorNode3DGizmo, subgizmo_id: int, xform: Transform3D) -> void:
	var node = gizmo.get_node_3d()
	if node == null:
		return
	var global_target: Vector3 = node.global_transform * xform.origin
	node.call("solve_ik", global_target)
	node.update_gizmos()


func _commit_subgizmos(gizmo: EditorNode3DGizmo, ids: PackedInt32Array, restores: Array[Transform3D], cancel: bool) -> void:
	var node = gizmo.get_node_3d()
	if node == null:
		return

	var angle_props = ["j1_angle", "j2_angle", "j3_angle", "j4_angle", "j5_angle", "j6_angle"]

	if cancel:
		for i in range(6):
			if i < _initial_joint_angles.size():
				node.set(angle_props[i], _initial_joint_angles[i])
		if EOAT_FOAM_SUBGIZMO_ID in ids:
			_eoat_mode = false
	else:
		var undo_redo = EditorInterface.get_editor_undo_redo()
		undo_redo.create_action("Move Robot End Effector")
		for i in range(6):
			undo_redo.add_do_property(node, angle_props[i], node.get(angle_props[i]))
			if i < _initial_joint_angles.size():
				undo_redo.add_undo_property(node, angle_props[i], _initial_joint_angles[i])
		undo_redo.commit_action()

	_initial_joint_angles = []
	node.update_gizmos()


func _ray_hits_foam_pad(ray_o: Vector3, ray_d: Vector3, cup_mesh: MeshInstance3D, length: float, width: float) -> bool:
	var xf_inv := cup_mesh.global_transform.affine_inverse()
	var lo: Vector3 = xf_inv * ray_o
	var ld: Vector3 = xf_inv.basis * ray_d
	var hs := Vector3(length * 0.5 + 0.05, 0.1, width * 0.5 + 0.05)
	var t0 := Vector3(-1e38, -1e38, -1e38)
	var t1 := Vector3(1e38, 1e38, 1e38)
	for i in 3:
		if abs(ld[i]) < 1e-8:
			if lo[i] < -hs[i] or lo[i] > hs[i]:
				return false
		else:
			var a: float = (-hs[i] - lo[i]) / ld[i]
			var b: float = (hs[i] - lo[i]) / ld[i]
			t0[i] = minf(a, b)
			t1[i] = maxf(a, b)
	var t_enter: float = maxf(maxf(t0.x, t0.y), t0.z)
	var t_exit: float = minf(minf(t1.x, t1.y), t1.z)
	return t_enter <= t_exit and t_exit >= 0.0


func _ray_to_axis_t(line_origin: Vector3, line_dir: Vector3, ray_origin: Vector3, ray_dir: Vector3) -> float:
	var b := line_dir.dot(ray_dir)
	var denom := 1.0 - b * b
	if abs(denom) < 1e-6:
		return 0.0
	var w := ray_origin - line_origin
	return (line_dir.dot(w) - b * ray_dir.dot(w)) / denom
