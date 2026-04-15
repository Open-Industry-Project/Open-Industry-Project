@tool
extends Node

## One-shot and live (Alt-held) snapping for platforms, stairs, and guard rails.

const SEARCH_RADIUS: float = 8.0
const LIVE_VISIBLE_THRESHOLD: float = 3.0
const LIVE_HEIGHT_TOLERANCE: float = 0.35
const LIVE_STAIRS_HEIGHT_PADDING: float = 0.25


func _enter_tree() -> void:
	if not Engine.is_editor_hint():
		return

	if get_node_or_null("StructureSnapPreview") == null:
		var preview_script: GDScript = load("res://addons/oip_ui/Autoload/StructureSnapPreview.gd")
		if preview_script:
			var preview: Node = preview_script.new()
			preview.name = "StructureSnapPreview"
			add_child(preview)


func snap_selected_structures() -> void:
	var selection := EditorInterface.get_selection()
	var selected_nodes := selection.get_selected_nodes()

	if selected_nodes.size() < 2:
		EditorInterface.get_editor_toaster().push_toast(
			"Select two structures to snap (Platform+Stairs, Platform+Platform, Platform+GuardRail).",
			EditorToaster.SEVERITY_WARNING)
		return

	var platforms: Array[Platform] = []
	var stairs_list: Array[Stairs] = []
	var rails: Array[GuardRail] = []

	for node in selected_nodes:
		if node is Platform:
			platforms.append(node as Platform)
		elif node is Stairs:
			stairs_list.append(node as Stairs)
		elif node is GuardRail:
			rails.append(node as GuardRail)

	if stairs_list.size() > 0 and platforms.size() > 0:
		_snap_stairs_to_platform(stairs_list[0], platforms[0])
	elif rails.size() >= 2 and platforms.is_empty():
		_snap_guardrail_to_guardrail(rails[0], rails[1])
	elif rails.size() > 0 and platforms.size() > 0:
		_snap_guardrail_to_platform(rails[0], platforms[0])
	elif platforms.size() >= 2:
		_snap_platform_to_platform(platforms[0], platforms[1])
	else:
		EditorInterface.get_editor_toaster().push_toast(
			"Select Platform+Stairs, Platform+GuardRail, GuardRail+GuardRail, or Platform+Platform.",
			EditorToaster.SEVERITY_WARNING)


static func find_snap_to_specific_platform(selected: Node3D, target: Platform, intent: Transform3D) -> Dictionary:
	if selected == null or not is_instance_valid(selected) or target == null or not is_instance_valid(target):
		return {}
	if target == selected:
		return {}
	if _horizontal_distance(target.global_position, intent.origin) > SEARCH_RADIUS:
		return {}

	var candidate: Variant = _calculate_snap_transform_for_intent(selected, target, intent)
	if candidate == null:
		return {}
	var candidate_transform: Transform3D = candidate
	var horizontal_delta := _horizontal_distance(intent.origin, candidate_transform.origin)
	if horizontal_delta > LIVE_VISIBLE_THRESHOLD:
		return {}
	var height_delta := absf(intent.origin.y - candidate_transform.origin.y)
	if height_delta > _get_live_height_tolerance(selected):
		return {}
	var score := horizontal_delta + height_delta * 0.2
	var result := {"transform": candidate_transform, "target": target, "distance": score}
	if selected is Stairs:
		var stairs := selected as Stairs
		var target_rise := maxf(stairs.size_min.y, target.global_position.y - target.floor_y)
		var target_run := StairsMesh.get_default_run_length(target_rise)
		result["size"] = Vector3(target_run, target_rise, stairs.size.z)
	return result


static func find_best_snap_to_platform(selected: Node3D, intent: Transform3D) -> Dictionary:
	if selected == null or not is_instance_valid(selected):
		return {}

	if not (selected is Platform or selected is Stairs or selected is GuardRail):
		return {}

	var best_result: Dictionary = {}
	var best_target: Platform = null
	var best_dist := INF

	var tree := selected.get_tree()
	if tree == null:
		return {}

	for target in Platform.instances:
		if not is_instance_valid(target):
			continue
		var r := find_snap_to_specific_platform(selected, target, intent)
		if r.is_empty():
			continue
		var d: float = r.distance
		if d < best_dist:
			best_dist = d
			best_result = r
			best_target = target

	if best_result.is_empty() or best_target == null:
		return {}
	return best_result


static func _calculate_snap_transform_for_intent(selected: Node3D, target: Platform, intent: Transform3D) -> Variant:
	if selected is Stairs:
		return _compute_stairs_to_platform_transform(selected as Stairs, target, intent)
	if selected is GuardRail:
		return _compute_guardrail_to_platform_transform(selected as GuardRail, target, intent)
	if selected is Platform:
		return _compute_platform_to_platform_transform(selected as Platform, target, intent)
	return null


static func _closest_point_on_segment_xz(point: Vector3, a: Vector3, b: Vector3) -> Vector3:
	var ab := b - a
	var ab_flat := Vector3(ab.x, 0, ab.z)
	var ap := point - a
	var ap_flat := Vector3(ap.x, 0, ap.z)
	var denom := ab_flat.dot(ab_flat)
	if denom < 0.0001:
		return a
	var t := clampf(ap_flat.dot(ab_flat) / denom, 0.0, 1.0)
	return a + ab * t


static func _horizontal_distance(a: Vector3, b: Vector3) -> float:
	return Vector2(a.x - b.x, a.z - b.z).length()


static func _get_live_height_tolerance(selected: Node3D) -> float:
	if selected is Stairs:
		var stairs := selected as Stairs
		return maxf(LIVE_HEIGHT_TOLERANCE, stairs.size.y * 0.5 + LIVE_STAIRS_HEIGHT_PADDING)
	return LIVE_HEIGHT_TOLERANCE


static func _horizontal_dir(v: Vector3, fallback: Vector3 = Vector3.RIGHT) -> Vector3:
	var flat := Vector3(v.x, 0, v.z)
	if flat.length_squared() < 0.0001:
		return fallback
	return flat.normalized()


static func _basis_with_x_axis(direction_x: Vector3) -> Basis:
	var x_axis := _horizontal_dir(direction_x, Vector3.RIGHT)
	var z_axis := x_axis.cross(Vector3.UP)
	if z_axis.length_squared() < 0.0001:
		z_axis = Vector3.BACK
	else:
		z_axis = z_axis.normalized()
	var y_axis := z_axis.cross(x_axis).normalized()
	return Basis(x_axis, y_axis, z_axis)


static func _basis_with_x_and_z(x_dir: Vector3, z_dir: Vector3) -> Basis:
	var x_axis := _horizontal_dir(x_dir, Vector3.RIGHT)
	var z_axis := _horizontal_dir(z_dir, Vector3.BACK)
	z_axis = (Vector3.UP.cross(x_axis)).normalized() if absf(x_axis.dot(z_axis)) > 0.999 else z_axis
	var y_axis := z_axis.cross(x_axis).normalized()
	z_axis = x_axis.cross(y_axis).normalized()
	return Basis(x_axis, y_axis, z_axis)


static func _get_platform_edges(p: Platform) -> Array:
	var xf := p.global_transform
	var hl := p.size.x / 2.0
	var hw := p.size.z / 2.0
	return [
		[xf * Vector3(hl, 0, -hw), xf * Vector3(hl, 0, hw), (xf.basis * Vector3.RIGHT).normalized()],
		[xf * Vector3(-hl, 0, hw), xf * Vector3(-hl, 0, -hw), (xf.basis * Vector3.LEFT).normalized()],
		[xf * Vector3(-hl, 0, hw), xf * Vector3(hl, 0, hw), (xf.basis * Vector3.BACK).normalized()],
		[xf * Vector3(hl, 0, -hw), xf * Vector3(-hl, 0, -hw), (xf.basis * Vector3.FORWARD).normalized()],
	]


func _snap_stairs_to_platform(stairs: Stairs, platform: Platform) -> void:
	var undo_redo := EditorInterface.get_editor_undo_redo()
	undo_redo.create_action("Snap Stairs to Platform")

	var target_rise := maxf(stairs.size_min.y, platform.global_position.y - platform.floor_y)
	var target_run := StairsMesh.get_default_run_length(target_rise)
	var new_size := Vector3(target_run, target_rise, stairs.size.z)
	var new_transform: Transform3D = _compute_stairs_to_platform_transform(stairs, platform, stairs.global_transform)

	undo_redo.add_do_property(stairs, "size", new_size)
	undo_redo.add_undo_property(stairs, "size", stairs.size)
	undo_redo.add_do_property(stairs, "global_transform", new_transform)
	undo_redo.add_undo_property(stairs, "global_transform", stairs.global_transform)
	undo_redo.commit_action()


static func _compute_stairs_to_platform_transform(stairs: Stairs, platform: Platform, intent: Transform3D) -> Transform3D:
	var s_pos := intent.origin
	var target_rise := maxf(stairs.size_min.y, platform.global_position.y - platform.floor_y)
	var target_run := StairsMesh.get_default_run_length(target_rise)
	var s_size := Vector3(target_run, target_rise, stairs.size.z)
	var s_hw := s_size.z / 2.0
	var edges := _get_platform_edges(platform)

	var best_seg_start := Vector3.ZERO
	var best_seg_end := Vector3.ZERO
	var best_outward := Vector3.RIGHT
	var best_closest := Vector3.ZERO
	var best_dist := INF

	for e in edges:
		var seg_s: Vector3 = e[0]
		var seg_e: Vector3 = e[1]
		var outward: Vector3 = e[2]
		var closest := _closest_point_on_segment_xz(s_pos, seg_s, seg_e)
		var d := Vector2(s_pos.x - closest.x, s_pos.z - closest.z).length()
		if d < best_dist:
			best_dist = d
			best_seg_start = seg_s
			best_seg_end = seg_e
			best_outward = outward
			best_closest = closest

	var edge_vec := best_seg_end - best_seg_start
	var edge_len := edge_vec.length()
	if edge_len > 0.01:
		var edge_dir := edge_vec / edge_len
		var t := (best_closest - best_seg_start).dot(edge_dir)
		t = clampf(t, s_hw, maxf(s_hw, edge_len - s_hw))
		best_closest = best_seg_start + edge_dir * t

	var outward_flat := _horizontal_dir(best_outward, Vector3.RIGHT)
	var stair_forward := -outward_flat
	var new_pos := best_closest + outward_flat * (s_size.x / 2.0)
	new_pos.y = platform.global_position.y

	var new_basis := _basis_with_x_axis(stair_forward)
	return Transform3D(new_basis, new_pos)


func _snap_guardrail_to_platform(guard_rail: GuardRail, platform: Platform) -> void:
	var undo_redo := EditorInterface.get_editor_undo_redo()
	undo_redo.create_action("Snap GuardRail to Platform")

	var new_transform: Transform3D = _compute_guardrail_to_platform_transform(guard_rail, platform, guard_rail.global_transform)
	undo_redo.add_do_property(guard_rail, "global_transform", new_transform)
	undo_redo.add_undo_property(guard_rail, "global_transform", guard_rail.global_transform)
	undo_redo.commit_action()


static func _compute_guardrail_to_platform_transform(guard_rail: GuardRail, platform: Platform, intent: Transform3D) -> Transform3D:
	var r_pos := intent.origin
	var r_half_len := guard_rail.size.x / 2.0
	var edges := _get_platform_edges(platform)

	var best_seg_start := Vector3.ZERO
	var best_seg_end := Vector3.ZERO
	var best_outward := Vector3.BACK
	var best_closest := Vector3.ZERO
	var best_dist := INF

	for e in edges:
		var seg_s: Vector3 = e[0]
		var seg_e: Vector3 = e[1]
		var outward: Vector3 = e[2]
		var closest := _closest_point_on_segment_xz(r_pos, seg_s, seg_e)
		var d := Vector2(r_pos.x - closest.x, r_pos.z - closest.z).length()
		if d < best_dist:
			best_dist = d
			best_seg_start = seg_s
			best_seg_end = seg_e
			best_outward = outward
			best_closest = closest

	var edge_vec := best_seg_end - best_seg_start
	var edge_len := edge_vec.length()
	var edge_dir := _horizontal_dir(edge_vec, Vector3.RIGHT)
	if edge_len > 0.01:
		var t := (best_closest - best_seg_start).dot(edge_dir)
		t = clampf(t, r_half_len, maxf(r_half_len, edge_len - r_half_len))
		best_closest = best_seg_start + edge_dir * t

	var outward_flat := _horizontal_dir(best_outward, Vector3.BACK)
	var new_basis := _basis_with_x_and_z(edge_dir, outward_flat)
	var new_pos := best_closest
	new_pos.y = platform.global_position.y
	return Transform3D(new_basis, new_pos)


func _snap_guardrail_to_guardrail(moving: GuardRail, target: GuardRail) -> void:
	var undo_redo := EditorInterface.get_editor_undo_redo()
	undo_redo.create_action("Snap GuardRail to GuardRail")

	var new_transform: Transform3D = _compute_guardrail_to_guardrail_transform(moving, target, moving.global_transform)
	undo_redo.add_do_property(moving, "global_transform", new_transform)
	undo_redo.add_undo_property(moving, "global_transform", moving.global_transform)
	undo_redo.commit_action()


static func _compute_guardrail_to_guardrail_transform(moving: GuardRail, target: GuardRail, intent: Transform3D) -> Transform3D:
	var target_basis := target.global_transform.basis.orthonormalized()
	var target_x := _horizontal_dir(target_basis.x, Vector3.RIGHT)
	var target_z := _horizontal_dir(target_basis.z, Vector3.BACK)
	var target_origin := target.global_position
	var target_half := target.size.x / 2.0
	var moving_half := moving.size.x / 2.0

	var moving_x_current := _horizontal_dir(intent.basis.x, Vector3.RIGHT)
	var alignment := absf(moving_x_current.dot(target_x))
	var is_perpendicular := alignment < 0.5

	if not is_perpendicular:
		var cand_plus := target_origin + target_x * (target_half + moving_half)
		var cand_minus := target_origin - target_x * (target_half + moving_half)
		var new_pos: Vector3
		if intent.origin.distance_squared_to(cand_plus) <= intent.origin.distance_squared_to(cand_minus):
			new_pos = cand_plus
		else:
			new_pos = cand_minus
		return Transform3D(target_basis, new_pos)

	# L-corner: moving end meets target end, 90° off target's X.
	var perp := Vector3(-target_x.z, 0, target_x.x)
	if moving_x_current.dot(perp) < 0.0:
		perp = -perp
	var corner_basis := _basis_with_x_axis(perp)
	var corner_x := _horizontal_dir(corner_basis.x, Vector3.RIGHT)
	var corner_z := _horizontal_dir(corner_basis.z, Vector3.BACK)
	var post_half := GuardRailMesh.POST_SIZE / 2.0

	var target_post_centers := [
		target_origin + target_x * target_half + target_z * post_half,
		target_origin - target_x * target_half + target_z * post_half,
	]
	var moving_end_offsets := [
		corner_x * moving_half + corner_z * post_half,
		-corner_x * moving_half + corner_z * post_half,
	]

	var best_center := intent.origin
	var best_dist := INF
	for t_end in target_post_centers:
		for m_off in moving_end_offsets:
			var center: Vector3 = t_end - m_off
			var d := intent.origin.distance_squared_to(center)
			if d < best_dist:
				best_dist = d
				best_center = center
	return Transform3D(corner_basis, best_center)


func _snap_platform_to_platform(moving: Platform, target: Platform) -> void:
	var undo_redo := EditorInterface.get_editor_undo_redo()
	undo_redo.create_action("Snap Platform to Platform")

	var best_transform: Transform3D = _compute_platform_to_platform_transform(moving, target, moving.global_transform)
	undo_redo.add_do_property(moving, "global_transform", best_transform)
	undo_redo.add_undo_property(moving, "global_transform", moving.global_transform)
	undo_redo.commit_action()


static func _compute_platform_to_platform_transform(moving: Platform, target: Platform, intent: Transform3D) -> Transform3D:
	var m_pos := intent.origin
	var current_basis := intent.basis
	var m_hl := moving.size.x / 2.0
	var m_hw := moving.size.z / 2.0

	var target_edges := _get_platform_edges(target)

	var m_edge_centers_local: Array[Vector3] = [
		Vector3(m_hl, 0, 0),
		Vector3(-m_hl, 0, 0),
		Vector3(0, 0, m_hw),
		Vector3(0, 0, -m_hw),
	]
	var m_edge_outwards_local: Array[Vector3] = [
		Vector3.RIGHT,
		Vector3.LEFT,
		Vector3.BACK,
		Vector3.FORWARD,
	]

	var current_forward := _horizontal_dir(current_basis.x, Vector3.RIGHT)
	var current_yaw := atan2(current_forward.z, current_forward.x)
	var target_basis := target.global_transform.basis.orthonormalized()

	var best_transform := intent
	var best_cost := INF

	for te in target_edges:
		var t_seg_start: Vector3 = te[0]
		var t_seg_end: Vector3 = te[1]
		var t_outward: Vector3 = _horizontal_dir(te[2], Vector3.RIGHT)

		for me_idx in range(4):
			var local_outward := m_edge_outwards_local[me_idx]
			var desired_outward := -t_outward

			# Candidate orientation must be target-aligned in 90° steps.
			var best_basis_for_pair := target_basis
			var best_dot := -INF
			for k in range(4):
				var candidate_basis := target_basis * Basis(Vector3.UP, float(k) * (PI * 0.5))
				var out_world := _horizontal_dir(candidate_basis * local_outward, Vector3.RIGHT)
				var d := out_world.dot(desired_outward)
				if d > best_dot:
					best_dot = d
					best_basis_for_pair = candidate_basis

			var candidate_basis := best_basis_for_pair
			var rotated_center := candidate_basis * m_edge_centers_local[me_idx]
			var yaw := atan2(_horizontal_dir(candidate_basis.x, Vector3.RIGHT).z, _horizontal_dir(candidate_basis.x, Vector3.RIGHT).x)
			var center_guess := m_pos + rotated_center
			var closest := _closest_point_on_segment_xz(center_guess, t_seg_start, t_seg_end)

			var candidate_pos := closest - rotated_center
			candidate_pos.y = target.global_position.y

			var move_cost := Vector2(candidate_pos.x - m_pos.x, candidate_pos.z - m_pos.z).length()
			var rot_cost := absf(wrapf(yaw - current_yaw, -PI, PI))
			var total_cost := move_cost + rot_cost * 0.35
			if total_cost < best_cost:
				best_cost = total_cost
				best_transform = Transform3D(candidate_basis, candidate_pos)

	return best_transform
