@tool
extends Node

## Overrides selected.global_transform during live preview to dodge xform cascade.
static var selected_xform_override: Variant = null
## Overrides target.global_transform during live preview.
static var target_xform_override: Variant = null

static var live_snap_enabled: bool = true

## Live-snap memoization, keyed by instance_id; empty in the manual snap path.
static var live_type_cache: Dictionary = {}
static var live_end_info_cache: Dictionary = {}

static func get_selected_xform(selected: Node3D) -> Transform3D:
	if selected_xform_override != null:
		return selected_xform_override
	return selected.global_transform


static func get_target_xform(target: Node3D) -> Transform3D:
	if target_xform_override != null:
		return target_xform_override
	return target.global_transform


func _enter_tree() -> void:
	if not Engine.is_editor_hint():
		return

	var editor_settings := EditorInterface.get_editor_settings()
	var snap_shortcut := Shortcut.new()
	var snap_key := InputEventKey.new()
	snap_key.keycode = KEY_C
	snap_key.ctrl_pressed = true
	snap_key.shift_pressed = true
	snap_shortcut.events.append(snap_key)
	editor_settings.add_shortcut("Open Industry Project/Snap Conveyor", snap_shortcut)

	# Path-loaded: autoloads parse before sibling class_names register.
	var live_snap_script: GDScript = load("res://addons/oip_ui/Autoload/ConveyorLiveSnap.gd")
	var live_snap: Node = live_snap_script.new()
	live_snap.name = "ConveyorLiveSnap"
	add_child(live_snap)


func _input(event: InputEvent) -> void:
	if not Engine.is_editor_hint():
		return

	var editor_settings := EditorInterface.get_editor_settings()
	if editor_settings.is_shortcut("Open Industry Project/Snap Conveyor", event) and event.is_pressed() and not event.is_echo():
		if _selection_has_structures():
			StructureSnapping.snap_selected_structures()
		else:
			snap_selected_conveyors()


static func _selection_has_structures() -> bool:
	for node in EditorInterface.get_selection().get_selected_nodes():
		if node is Platform or node is Stairs or node is GuardRail:
			return true
	return false


static func snap_selected_conveyors() -> void:
	# Clear any leak from a live-preview call.
	selected_xform_override = null

	var selection := EditorInterface.get_selection()
	var selected_conveyors: Array[Node3D] = []
	var target_conveyor := EditorInterface.get_active_node_3d()
	
	if not target_conveyor:
		EditorInterface.get_editor_toaster().push_toast("No active node found - please click on a target conveyor first", EditorToaster.SEVERITY_WARNING)
		return
	
	if not _is_conveyor(target_conveyor):
		EditorInterface.get_editor_toaster().push_toast("Active node is not a conveyor - please select a conveyor as target", EditorToaster.SEVERITY_WARNING)
		return
	
	for node in selection.get_selected_nodes():
		if (_is_conveyor(node) or _is_diverter(node) or _is_chain_transfer(node) or _is_blade_stop(node)) and node != target_conveyor:
			selected_conveyors.append(node as Node3D)

	if selected_conveyors.is_empty():
		EditorInterface.get_editor_toaster().push_toast("No valid conveyors selected for snapping (target conveyor excluded)", EditorToaster.SEVERITY_WARNING)
		return

	for node in selected_conveyors:
		if (_is_chain_transfer(node) or _is_blade_stop(node)) and not _is_roller_conveyor(target_conveyor):
			var label := "Chain transfers" if _is_chain_transfer(node) else "Blade stops"
			EditorInterface.get_editor_toaster().push_toast("%s can only be snapped onto a roller conveyor" % label, EditorToaster.SEVERITY_WARNING)
			return
	
	var undo_redo := EditorInterface.get_editor_undo_redo()

	var has_curved := false
	var has_side_guards := false
	var has_diverter := false
	var has_chain_transfer := false
	var has_blade_stop := false

	for conveyor in selected_conveyors:
		if _is_curved_conveyor(conveyor) or _is_curved_conveyor(target_conveyor):
			has_curved = true
		if _has_side_guards(conveyor) or _has_side_guards(target_conveyor):
			has_side_guards = true
		if _is_diverter(conveyor):
			has_diverter = true
		if _is_chain_transfer(conveyor):
			has_chain_transfer = true
		if _is_blade_stop(conveyor):
			has_blade_stop = true

	var action_name: String
	if has_blade_stop:
		action_name = "Snap Blade Stop Between Rollers"
	elif has_chain_transfer:
		action_name = "Snap Chain Transfer Between Rollers"
	elif has_diverter:
		action_name = "Snap Diverter with Side Guard Openings" if has_side_guards else "Snap Diverter"
	elif has_curved and has_side_guards:
		action_name = "Snap Curved Conveyors with Side Guard Openings"
	elif has_curved:
		action_name = "Snap Curved Conveyors"
	elif has_side_guards:
		action_name = "Snap Conveyors with Side Guard Openings"
	else:
		action_name = "Snap Conveyors"
	
	undo_redo.create_action(action_name)

	for conveyor in selected_conveyors:
		var original_transform := conveyor.global_transform
		var snap_result := _calculate_snap_transform(conveyor, target_conveyor)
		var snap_transform: Transform3D = snap_result.transform
		var is_end_to_end: bool = snap_result.is_end_to_end
		undo_redo.add_do_property(conveyor, "global_transform", snap_transform)
		undo_redo.add_undo_property(conveyor, "global_transform", original_transform)

		if snap_result.get("needs_reverse", false):
			var reverse_prop := get_reverse_property_name(conveyor)
			if reverse_prop != &"":
				var current_reverse: bool = bool(conveyor.get(reverse_prop))
				undo_redo.add_do_property(conveyor, reverse_prop, not current_reverse)
				undo_redo.add_undo_property(conveyor, reverse_prop, current_reverse)

		# Chain transfers / blade stops sit between rollers; never T-junction.
		if not is_end_to_end and not _is_chain_transfer(conveyor) and not _is_blade_stop(conveyor):
			if _is_diverter(conveyor):
				_open_side_guards_for_diverter(undo_redo, snap_transform, conveyor, target_conveyor)
			else:
				_connect_side_guards(undo_redo, conveyor, target_conveyor, snap_result)

	undo_redo.commit_action()


## Diverter-only: assumes the snap places the diverter adjacent to exactly one side.
static func _calculate_diverter_intersection_for_transform(snapped_conveyor: Node3D, target_conveyor: Node3D, snapped_transform: Transform3D) -> Dictionary:
	var target_transform := target_conveyor.global_transform
	var snapped_size := _get_conveyor_size(snapped_conveyor)

	var target_inverse := target_transform.affine_inverse()
	var snapped_local_transform := target_inverse * snapped_transform

	var snapped_half_length := snapped_size.x / 2.0
	var snapped_half_width := snapped_size.z / 2.0
	# Path-based targets are origin-at-tail; use real X bounds.
	var t_bounds := _get_conveyor_x_bounds(target_conveyor)

	# Full Vector3 corners: stripping Y misattributes corners on elevated runs.
	var corners: Array[Vector3] = []
	var min_x: float = INF
	var max_x: float = -INF

	for x_sign: int in [-1, 1]:
		for z_sign: int in [-1, 1]:
			var local_corner: Vector3 = snapped_local_transform.origin + snapped_local_transform.basis.x * (x_sign * snapped_half_length) + snapped_local_transform.basis.z * (z_sign * snapped_half_width)
			corners.append(local_corner)
			min_x = min(min_x, local_corner.x)
			max_x = max(max_x, local_corner.x)

	if max_x < t_bounds.x or min_x > t_bounds.y:
		return {}

	var intersections := []
	var side_guard_margin: float = 0.15 if _has_side_guards(snapped_conveyor) else 0.05

	# Resolve the diverter's footprint to an arc-length range on the target.
	if _has_spur_angles(snapped_conveyor):
		var spur_angles := _get_spur_angles(snapped_conveyor)
		var spur_angle: float = spur_angles.downstream
		if abs(spur_angle) > 0.001:
			var left_extent: float = snapped_half_length + tan(spur_angle) * (-snapped_half_width)
			var right_extent: float = snapped_half_length + tan(spur_angle) * snapped_half_width

			var side_guard_thickness: float = 0.1
			var edge_a: Vector3 = snapped_local_transform * Vector3(left_extent, 0, -snapped_half_width - side_guard_thickness)
			var edge_b: Vector3 = snapped_local_transform * Vector3(right_extent, 0, snapped_half_width + side_guard_thickness)
			corners = [edge_a, edge_b]

	var arc_bounds: Vector2 = _get_conveyor_arc_bounds(target_conveyor)
	var arc_min: float = INF
	var arc_max: float = -INF
	for c: Vector3 in corners:
		var arc: float = _local_pos_to_arc(target_conveyor, c)
		arc_min = minf(arc_min, arc)
		arc_max = maxf(arc_max, arc)
	arc_min = maxf(arc_min, arc_bounds.x)
	arc_max = minf(arc_max, arc_bounds.y)
	var opening_position: float = (arc_min + arc_max) / 2.0
	var opening_size: float = (arc_max - arc_min) + side_guard_margin

	var side_str: String = "left" if snapped_local_transform.origin.z < 0.0 else "right"
	intersections.append({
		"side": side_str,
		"position": opening_position,
		"size": opening_size,
	})

	return {"intersections": intersections}


## Opens a gap in the target's side guards via the declarative openings array.
static func _shrink_guards_for_gap(undo_redo: EditorUndoRedoManager, conveyor: Node3D, intersection_info: Dictionary) -> void:
	if not intersection_info.has("intersections"):
		return
	if not conveyor.has_method("request_side_guard_opening"):
		return
	var intersections := intersection_info["intersections"] as Array
	var b_old: Array[SideGuardOpening] = (conveyor.get(&"side_guard_openings") as Array).duplicate(true)
	var b_new: Array[SideGuardOpening] = b_old.duplicate(true)
	for intersection: Dictionary in intersections:
		var side_str: String = intersection["side"]
		var gap_center: float = intersection["position"]
		var gap_size: float = intersection["size"]
		var gap_start: float = gap_center - gap_size / 2.0
		var gap_end: float = gap_center + gap_size / 2.0
		if gap_end - gap_start < 0.01:
			continue
		b_new.append(SideGuardOpening.make(gap_start, gap_end, side_str))
	if b_new.size() == b_old.size():
		return
	undo_redo.add_do_property(conveyor, "side_guard_openings", b_new)
	undo_redo.add_undo_property(conveyor, "side_guard_openings", b_old)


## Trims snapped conveyor's guards and opens target's guards by writing openings arrays.
static func _connect_side_guards_path_based(
	undo_redo: EditorUndoRedoManager,
	snapped_conveyor: Node3D, target_conveyor: Node3D,
	snap_result: Dictionary,
	skip_snapped_undo: bool
) -> void:
	var snap_transform: Transform3D = snap_result.transform
	var target_xform := target_conveyor.global_transform
	var target_inverse := target_xform.affine_inverse()
	var target_size := _get_conveyor_size(target_conveyor)
	var frame_wt := ConveyorFrameMesh.WALL_THICKNESS
	var target_half_width: float = target_size.z * 0.5

	# Prefer snap result's recorded side; bbox test is fallback.
	var target_end_dict: Dictionary = snap_result.get("target_end", {}) as Dictionary
	var target_end_name: StringName = target_end_dict.get("name", &"") as StringName
	var side_str: String
	if target_end_name == &"left_side":
		side_str = "left"
	elif target_end_name == &"right_side":
		side_str = "right"
	else:
		var snapped_center_in_target: Vector3 = target_inverse * snap_transform.origin
		if abs(snapped_center_in_target.z + target_half_width) < abs(snapped_center_in_target.z - target_half_width):
			side_str = "left"
		else:
			side_str = "right"

	# Ray target = target's outer wall plane. Spur stops at the belt's outer face so its
	# frame doesn't intrude into the belt's slot interior.
	var side_z_local: float = (target_half_width + frame_wt) if side_str == "right" else -(target_half_width + frame_wt)
	var plane_point: Vector3 = target_xform * Vector3(0, 0, side_z_local)
	var plane_normal: Vector3 = target_xform.basis.z.normalized()
	if side_str == "left":
		plane_normal = -plane_normal

	var a_xform := snap_transform
	# dir_sign>0: A's FRONT approaches B's plane (trim front); <0: BACK approaches.
	var snap_x_world: Vector3 = a_xform.basis.x.normalized()
	var dir_sign: float = -1.0 if snap_x_world.dot(plane_normal) > 0.0 else 1.0

	var a_width: float = float(snapped_conveyor.get(&"width")) if &"width" in snapped_conveyor else 1.524
	var a_half_w: float = a_width * 0.5
	var a_lateral_offsets := {
		"left": -(a_half_w + frame_wt),
		"right": a_half_w + frame_wt,
	}

	# Full Vector3 hits: stripping Y mis-attributes hits on elevated runs.
	var hits_in_target_local: Array[Vector3] = []
	var pending_openings: Array[SideGuardOpening] = []
	# For spurs only: per-side endpoint overrides that EXTEND the side guard up to
	# the target's wall plane (openings can only trim, not extend).
	var snapped_is_spur: bool = &"side_guard_snap_extents" in snapped_conveyor
	var pending_extents: Dictionary = {}
	var end_key_suffix: String = "_front" if dir_sign > 0.0 else "_back"

	# Leading edge as arc-length: head (arc_bounds.y) if front-snap, tail (.x) if back-snap.
	var sn_arc_bounds: Vector2 = _get_conveyor_arc_bounds(snapped_conveyor)
	var snapped_arc_leading: float = sn_arc_bounds.y if dir_sign > 0.0 else sn_arc_bounds.x

	for side: String in ["left", "right"]:
		var bounds: Vector2 = _snapped_side_x_bounds(snapped_conveyor, side)
		var trailing_x: float = bounds.x if dir_sign > 0.0 else bounds.y
		var z_off: float = a_lateral_offsets[side]
		var ray_origin_world: Vector3 = a_xform * Vector3(trailing_x, 0, z_off)
		var ray_dir: Vector3 = snap_x_world * dir_sign
		var denom: float = ray_dir.dot(plane_normal)
		if absf(denom) < 0.001:
			continue
		var t_hit: float = (plane_point - ray_origin_world).dot(plane_normal) / denom
		if t_hit < 0.01:
			continue
		var hit_world: Vector3 = ray_origin_world + ray_dir * t_hit
		hits_in_target_local.append(target_inverse * hit_world)
		var hit_local: Vector3 = a_xform.affine_inverse() * hit_world
		var hit_x: float = hit_local.x
		if snapped_is_spur:
			# Override the side guard's natural extent to land on the target's wall plane.
			pending_extents[side + end_key_suffix] = hit_x
		else:
			# Path-based belt: trim from leading edge to hit (arc-length space).
			var hit_arc: float = _local_pos_to_arc(snapped_conveyor, hit_local)
			var open_start: float
			var open_end: float
			if dir_sign > 0.0:
				open_start = hit_arc
				open_end = snapped_arc_leading + 0.001
			else:
				open_start = snapped_arc_leading - 0.001
				open_end = hit_arc
			if open_end - open_start > 0.001:
				pending_openings.append(SideGuardOpening.make(open_start, open_end, side))

	if pending_openings.is_empty() and pending_extents.is_empty() and hits_in_target_local.size() < 2:
		return

	if not pending_openings.is_empty():
		var old_guard_openings: Array[SideGuardOpening] = (snapped_conveyor.get(&"side_guard_openings") as Array).duplicate(true)
		var new_guard_openings: Array[SideGuardOpening] = old_guard_openings.duplicate(true)
		for op: SideGuardOpening in pending_openings:
			new_guard_openings.append(op)
		undo_redo.add_do_property(snapped_conveyor, "side_guard_openings", new_guard_openings)
		if not skip_snapped_undo:
			undo_redo.add_undo_property(snapped_conveyor, "side_guard_openings", old_guard_openings)

	if not pending_extents.is_empty():
		var old_extents: Dictionary = (snapped_conveyor.get(&"side_guard_snap_extents") as Dictionary).duplicate(true)
		var new_extents: Dictionary = old_extents.duplicate(true)
		for k: String in pending_extents:
			new_extents[k] = pending_extents[k]
		undo_redo.add_do_property(snapped_conveyor, "side_guard_snap_extents", new_extents)
		if not skip_snapped_undo:
			undo_redo.add_undo_property(snapped_conveyor, "side_guard_snap_extents", old_extents)

	# B-side opening: prefer the actual ray hits (spur's outer-face corners on the target
	# plane) so splayed spurs land symmetric on their own footprint instead of centered on
	# the centerline. Shrink each side by sg_wt so the opening matches the INNER-face
	# footprint — that's where the spur's inner face meets the target's wall.
	var has_contact: bool = target_end_dict.has("pos") and target_conveyor.has_method(&"local_to_arc_length")
	var contact_local: Vector3 = target_end_dict.get("pos", Vector3.ZERO) as Vector3
	var sg_wt: float = SideGuardMesh.WALL_THICKNESS
	if hits_in_target_local.size() >= 2:
		var arc_min: float = INF
		var arc_max: float = -INF
		for h: Vector3 in hits_in_target_local:
			var arc: float = _local_pos_to_arc(target_conveyor, h)
			arc_min = minf(arc_min, arc)
			arc_max = maxf(arc_max, arc)
		var arc_bounds := _get_conveyor_arc_bounds(target_conveyor)
		var gap_start: float = maxf(arc_min + sg_wt, arc_bounds.x)
		var gap_end: float = minf(arc_max - sg_wt, arc_bounds.y)
		if gap_end - gap_start > 0.01:
			_append_target_opening(undo_redo, target_conveyor, &"side_guard_openings", gap_start, gap_end, side_str)
	elif has_contact:
		# Fallback: contact-centered with nominal width (used when ray hits don't fire,
		# e.g. shallow grazing approach or diverter snap).
		var center_arc: float = _local_pos_to_arc(target_conveyor, contact_local)
		var snapped_width: float = float(snapped_conveyor.get(&"width")) if &"width" in snapped_conveyor else _get_conveyor_size(snapped_conveyor).z
		var half_open: float = snapped_width * 0.5 + frame_wt - sg_wt
		if target_conveyor.has_method(&"tangent_at_local_pos"):
			var tangent_local: Vector3 = target_conveyor.call(&"tangent_at_local_pos", contact_local)
			var tangent_world: Vector3 = (target_xform.basis * tangent_local).normalized()
			var snap_z_world: Vector3 = snap_transform.basis.z.normalized()
			var cos_angle: float = absf(tangent_world.dot(snap_z_world))
			cos_angle = maxf(cos_angle, 0.5)
			half_open = half_open / cos_angle
		var arc_bounds: Vector2 = _get_conveyor_arc_bounds(target_conveyor)
		var gap_start: float = maxf(center_arc - half_open, arc_bounds.x)
		var gap_end: float = minf(center_arc + half_open, arc_bounds.y)
		if gap_end - gap_start > 0.01:
			_append_target_opening(undo_redo, target_conveyor, &"side_guard_openings", gap_start, gap_end, side_str)


static func _append_target_opening(undo_redo: EditorUndoRedoManager, target: Node3D, prop: StringName,
		gap_start: float, gap_end: float, side: String) -> void:
	var old: Array[SideGuardOpening] = (target.get(prop) as Array).duplicate(true)
	var new_arr: Array[SideGuardOpening] = old.duplicate(true)
	new_arr.append(SideGuardOpening.make(gap_start, gap_end, side))
	undo_redo.add_do_property(target, prop, new_arr)
	undo_redo.add_undo_property(target, prop, old)


## [back_x, front_x] of side guard in conveyor-local cartesian space.
static func _snapped_side_x_bounds(conveyor: Node3D, side: String) -> Vector2:
	if &"angle_downstream" in conveyor:
		var sn_length: float = float(conveyor.get(&"length")) if &"length" in conveyor else 2.0
		var sn_width: float = float(conveyor.get(&"width")) if &"width" in conveyor else 1.524
		var sn_angle_ds: float = float(conveyor.get(&"angle_downstream"))
		var sn_angle_us: float = float(conveyor.get(&"angle_upstream")) if &"angle_upstream" in conveyor else 0.0
		var inner_z: float = -sn_width * 0.5 if side == "left" else sn_width * 0.5
		var back_x: float = -sn_length * 0.5 + tan(sn_angle_us) * inner_z
		var front_x: float = sn_length * 0.5 + tan(sn_angle_ds) * inner_z
		return Vector2(back_x, front_x)
	if &"local_bbox" in conveyor:
		var bb: AABB = conveyor.get(&"local_bbox")
		if bb.size != Vector3.ZERO:
			return Vector2(bb.position.x, bb.end.x)
	# Fallback for path-based conveyors before _rebuild populates local_bbox.
	if conveyor.has_method(&"arc_bounds"):
		return conveyor.call(&"arc_bounds") as Vector2
	return Vector2(-2.0, 2.0)


## T-junction sideguard connection via ray-plane intersection.
## [param skip_snapped_undo]: caller removes snapped's subtree on undo, so skip undo ops.
static func _connect_side_guards(
	undo_redo: EditorUndoRedoManager,
	snapped_conveyor: Node3D, target_conveyor: Node3D,
	snap_result: Dictionary,
	skip_snapped_undo: bool = false
) -> void:
	_connect_side_guards_path_based(undo_redo, snapped_conveyor, target_conveyor,
			snap_result, skip_snapped_undo)


static func _has_side_guards(conveyor: Node3D) -> bool:
	return ("right_side_guards_enabled" in conveyor and
			"left_side_guards_enabled" in conveyor)


static func _is_conveyor(node: Node) -> bool:
	var node_script: Script = node.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := node.get_class()

	var conveyor_types := [
		"BeltSpurConveyor",
		"RollerSpurConveyor",
		"BeltConveyor", "RollerConveyor",
		"CurvedBeltConveyor", "CurvedRollerConveyor",
	]

	return global_name in conveyor_types or node_class in conveyor_types


static func _make_snap_result(snap_transform: Transform3D, snapped_end: Dictionary, target_end: Dictionary) -> Dictionary:
	var end_names := [&"front", &"back", &"head", &"tail"]
	return {
		"transform": snap_transform,
		"snapped_end": snapped_end,
		"target_end": target_end,
		"is_end_to_end": snapped_end.name in end_names and target_end.name in end_names,
	}


static func _calculate_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D, live_mode: bool = false) -> Dictionary:
	if _is_curved_conveyor(selected_conveyor) or _is_curved_conveyor(target_conveyor):
		return _calculate_curved_snap_transform(selected_conveyor, target_conveyor, live_mode)

	if _has_spur_angles(selected_conveyor):
		return _calculate_spur_snap_transform(selected_conveyor, target_conveyor, live_mode)

	if _has_spur_angles(target_conveyor):
		return _calculate_snap_to_spur_target_transform(selected_conveyor, target_conveyor, live_mode)

	return ConveyorSnapFeatures.try_snap(selected_conveyor, target_conveyor, live_mode)


static func _get_conveyor_size(conveyor: Node3D) -> Vector3:
	if "size" in conveyor:
		return conveyor.size
	return Vector3(4.0, 0.5, 1.524)


## Returns [back_x, front_x] in local space; path-based and centered conveyors handled.
static func _get_conveyor_x_bounds(conveyor: Node3D) -> Vector2:
	if conveyor != null and &"local_bbox" in conveyor:
		var bb: AABB = conveyor.get(&"local_bbox")
		if bb.size != Vector3.ZERO:
			return Vector2(bb.position.x, bb.end.x)
	var s: Vector3 = _get_conveyor_size(conveyor)
	return Vector2(-s.x * 0.5, s.x * 0.5)


## Arc-length bounds (path-based) or cartesian X bounds (legacy).
static func _get_conveyor_arc_bounds(conveyor: Node3D) -> Vector2:
	if conveyor != null and conveyor.has_method(&"arc_bounds"):
		return conveyor.call(&"arc_bounds") as Vector2
	return _get_conveyor_x_bounds(conveyor)


## Conveyor-local 3D point → arc-length on path. Takes full Vector3 (Y matters for elevated runs).
static func _local_pos_to_arc(conveyor: Node3D, local_pos: Vector3) -> float:
	if conveyor != null and conveyor.has_method(&"local_to_arc_length"):
		return float(conveyor.call(&"local_to_arc_length", local_pos))
	return local_pos.x


static func _get_closest_point_on_line_segment(point: Vector3, line_start: Vector3, line_end: Vector3) -> Vector3:
	var line_vector := line_end - line_start
	var line_length_squared := line_vector.length_squared()
	
	if line_length_squared == 0.0:
		return line_start
	
	var point_to_start := point - line_start
	var projection_factor := point_to_start.dot(line_vector) / line_length_squared
	projection_factor = clampf(projection_factor, 0.0, 1.0)
	
	return line_start + projection_factor * line_vector


## [min_x, max_x] where the polygon intersects a horizontal Z line; empty on no intersection.
static func _get_x_range_at_z(corners: Array[Vector3], z_val: float) -> Array[float]:
	var x_values: Array[float] = []
	var n := corners.size()
	for i in range(n):
		var a := corners[i]
		var b := corners[(i + 1) % n]
		if (a.z <= z_val and b.z >= z_val) or (a.z >= z_val and b.z <= z_val):
			if absf(b.z - a.z) < 0.0001:
				x_values.append(a.x)
				x_values.append(b.x)
			else:
				var t := (z_val - a.z) / (b.z - a.z)
				x_values.append(a.x + t * (b.x - a.x))
	if x_values.is_empty():
		return []
	return [x_values.min(), x_values.max()]


static func _get_z_inclination(transform: Transform3D) -> float:
	var forward := transform.basis.x.normalized()
	return atan2(forward.y, Vector2(forward.x, forward.z).length())


static func _apply_inclination_to_basis(basis: Basis, inclination: float) -> Basis:
	var horizontal_forward := Vector3(basis.x.x, 0, basis.x.z).normalized()
	var horizontal_right := Vector3(basis.z.x, 0, basis.z.z).normalized()
	
	var inclined_forward := horizontal_forward * cos(inclination) + Vector3.UP * sin(inclination)
	
	var new_basis := Basis()
	new_basis.x = inclined_forward
	new_basis.z = horizontal_right
	new_basis.y = new_basis.z.cross(new_basis.x).normalized()
	
	return new_basis 



static func _is_curved_conveyor(conveyor: Node3D) -> bool:
	if not live_type_cache.is_empty():
		var f: Variant = live_type_cache.get(conveyor.get_instance_id())
		if f != null:
			return f.is_curved
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()

	var curved_types := [
		"CurvedBeltConveyor", "CurvedRollerConveyor"
	]

	return global_name in curved_types or node_class in curved_types


static func _is_curved_roller_conveyor(conveyor: Node3D) -> bool:
	if not live_type_cache.is_empty():
		var f: Variant = live_type_cache.get(conveyor.get_instance_id())
		if f != null:
			return f.is_curved_roller
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()

	var curved_roller_types := [
		"CurvedRollerConveyor"
	]

	return global_name in curved_roller_types or node_class in curved_roller_types


static func _is_straight_conveyor_assembly(_conveyor: Node3D) -> bool:
	return false


static func _is_spur_conveyor(conveyor: Node3D) -> bool:
	if not live_type_cache.is_empty():
		var f: Variant = live_type_cache.get(conveyor.get_instance_id())
		if f != null:
			return f.is_spur
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()
	var spur_types := ["BeltSpurConveyor", "RollerSpurConveyor"]
	return global_name in spur_types or node_class in spur_types


static func _get_spur_angles(conveyor: Node3D) -> Dictionary:
	var angle_ds: float = 0.0
	var angle_us: float = 0.0
	if "angle_downstream" in conveyor:
		angle_ds = conveyor.angle_downstream
	if "angle_upstream" in conveyor:
		angle_us = conveyor.angle_upstream
	return {"downstream": angle_ds, "upstream": angle_us}


static func _has_spur_angles(conveyor: Node3D) -> bool:
	if not live_type_cache.is_empty():
		var f: Variant = live_type_cache.get(conveyor.get_instance_id())
		if f != null:
			return f.has_spur
	if not _is_spur_conveyor(conveyor):
		return false
	var angles := _get_spur_angles(conveyor)
	return abs(angles.downstream) > 0.001 or abs(angles.upstream) > 0.001


static func _get_curved_conveyor_angle(conveyor: Node3D) -> float:
	if "conveyor_angle" in conveyor:
		return conveyor.conveyor_angle
	var corner = conveyor.get_node_or_null("ConveyorCorner")
	if corner and "conveyor_angle" in corner:
		return corner.conveyor_angle
	return 90.0


static func _get_curved_conveyor_params(conveyor: Node3D) -> Dictionary:
	var inner_radius := 0.5
	var width := 1.524
	if "inner_radius" in conveyor:
		inner_radius = conveyor.inner_radius
	elif "inner_radius_f" in conveyor:
		inner_radius = conveyor.inner_radius_f
	if "width" in conveyor:
		width = conveyor.width
	var corner = conveyor.get_node_or_null("ConveyorCorner")
	if corner:
		if "inner_radius" in corner:
			inner_radius = corner.inner_radius
		if "width" in corner:
			width = corner.width
	return {"inner_radius": inner_radius, "width": width}


static func _get_curved_end_info(conveyor: Node3D) -> Array[Dictionary]:
	var angle_deg := _get_curved_conveyor_angle(conveyor)
	var angle_rad := deg_to_rad(angle_deg)
	var params := _get_curved_conveyor_params(conveyor)
	var avg_radius: float = params.inner_radius + params.width / 2.0

	var corner = conveyor.get_node_or_null("ConveyorCorner")
	var cc_offset: Vector3 = corner.position if corner else Vector3.ZERO

	var tail_pos: Vector3 = cc_offset + Vector3(0, 0, avg_radius)
	var tail_outward := Vector3(1, 0, 0)

	var head_pos: Vector3 = cc_offset + Vector3(-sin(angle_rad) * avg_radius, 0, cos(angle_rad) * avg_radius)
	var head_outward := Vector3(-cos(angle_rad), 0, -sin(angle_rad))

	return [
		{"pos": tail_pos, "outward": tail_outward, "name": "tail"},
		{"pos": head_pos, "outward": head_outward, "name": "head"},
	]


static func _get_straight_end_info(conveyor: Node3D) -> Array[Dictionary]:
	# Prefer the path-based real 3D end positions; fall back to symmetric X-bounds.
	if conveyor != null and conveyor.has_method(&"get_snap_features"):
		var features: Array = conveyor.call(&"get_snap_features")
		var front: Dictionary = {}
		var back: Dictionary = {}
		for f: Dictionary in features:
			match f.get(&"kind", &""):
				&"straight_end_front":
					front = f
				&"straight_end_back":
					back = f
		if not front.is_empty() and not back.is_empty():
			return [
				{"pos": front.local_pos, "outward": front.get(&"local_outward", Vector3(1, 0, 0)), "name": "front"},
				{"pos": back.local_pos, "outward": back.get(&"local_outward", Vector3(-1, 0, 0)), "name": "back"},
			]
	var x_bounds := _get_conveyor_x_bounds(conveyor)
	return [
		{"pos": Vector3(x_bounds.y, 0, 0), "outward": Vector3(1, 0, 0), "name": "front"},
		{"pos": Vector3(x_bounds.x, 0, 0), "outward": Vector3(-1, 0, 0), "name": "back"},
	]


static func _get_spur_end_info(conveyor: Node3D) -> Array[Dictionary]:
	var size := _get_conveyor_size(conveyor)
	var angles := _get_spur_angles(conveyor)
	var ds_outward := Vector3(cos(angles.downstream), 0, -sin(angles.downstream))
	var us_outward := Vector3(-cos(angles.upstream), 0, sin(angles.upstream))
	return [
		{"pos": Vector3(size.x, 0, 0), "outward": ds_outward, "name": "front"},
		{"pos": Vector3(0, 0, 0), "outward": us_outward, "name": "back"},
	]


static func _get_end_info(conveyor: Node3D) -> Array[Dictionary]:
	if not live_end_info_cache.is_empty():
		var cached: Variant = live_end_info_cache.get(conveyor.get_instance_id())
		if cached != null:
			return cached
	if _is_curved_conveyor(conveyor):
		return _get_curved_end_info(conveyor)
	if _has_spur_angles(conveyor):
		return _get_spur_end_info(conveyor)
	return _get_straight_end_info(conveyor)


static func _snap_end_to_end(
	selected_conveyor: Node3D,
	sel_end: Dictionary,
	target_conveyor: Node3D,
	tgt_end: Dictionary,
	gap: float
) -> Transform3D:
	var target_transform := get_target_xform(target_conveyor)
	var tgt_pos: Vector3 = tgt_end.pos
	var tgt_out: Vector3 = tgt_end.outward
	var tgt_end_world: Vector3 = target_transform * tgt_pos
	var tgt_outward_world: Vector3 = (target_transform.basis * tgt_out).normalized()

	var desired_outward: Vector3 = -tgt_outward_world
	var sel_out: Vector3 = sel_end.outward
	var sel_pos_local: Vector3 = sel_end.pos
	var sel_heading := atan2(sel_out.x, sel_out.z)
	var desired_heading := atan2(desired_outward.x, desired_outward.z)
	var y_rotation := desired_heading - sel_heading

	var new_basis := Basis(Vector3.UP, y_rotation)
	var rotated_sel_end: Vector3 = new_basis * sel_pos_local
	var snap_pos: Vector3 = tgt_end_world + tgt_outward_world * gap - rotated_sel_end

	return Transform3D(new_basis, snap_pos)


static func _get_snap_gap(selected_conveyor: Node3D, target_conveyor: Node3D) -> float:
	var sel_curved := _is_curved_conveyor(selected_conveyor)
	var tgt_curved := _is_curved_conveyor(target_conveyor)

	if sel_curved and tgt_curved:
		var both_roller := _is_curved_roller_conveyor(selected_conveyor) and _is_curved_roller_conveyor(target_conveyor)
		var both_belt := not _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor)
		if both_roller:
			return 0.004
		elif both_belt:
			return 0.5
		return 0.25
	elif sel_curved or tgt_curved:
		var curved := selected_conveyor if sel_curved else target_conveyor
		if _is_curved_roller_conveyor(curved):
			return 0.001
		return 0.25
	return 0.0


static func _find_closest_end_pair(selected_conveyor: Node3D, target_conveyor: Node3D) -> Array[Dictionary]:
	var sel_ends := _get_end_info(selected_conveyor)
	var tgt_ends := _get_end_info(target_conveyor)
	var sel_transform := get_selected_xform(selected_conveyor)
	var tgt_transform := get_target_xform(target_conveyor)

	var best_dist := INF
	var best_sel: Dictionary
	var best_tgt: Dictionary

	for se in sel_ends:
		for te in tgt_ends:
			var se_pos: Vector3 = se.pos
			var te_pos: Vector3 = te.pos
			var sel_world: Vector3 = sel_transform * se_pos
			var tgt_world: Vector3 = tgt_transform * te_pos
			var dist := sel_world.distance_to(tgt_world)
			if dist < best_dist:
				best_dist = dist
				best_sel = se
				best_tgt = te

	return [best_sel, best_tgt]


## Same target end, flipped selected end — mirrors selected's orientation at the attachment.
static func _find_resnap_end_pair(selected_conveyor: Node3D, target_conveyor: Node3D) -> Array[Dictionary]:
	var sel_ends := _get_end_info(selected_conveyor)
	var tgt_ends := _get_end_info(target_conveyor)
	var sel_transform := get_selected_xform(selected_conveyor)
	var tgt_transform := get_target_xform(target_conveyor)

	var best_dist := INF
	var snapped_sel_idx := 0
	var snapped_tgt_idx := 0

	for si in range(sel_ends.size()):
		for ti in range(tgt_ends.size()):
			var se_pos: Vector3 = sel_ends[si].pos
			var te_pos: Vector3 = tgt_ends[ti].pos
			var sel_world: Vector3 = sel_transform * se_pos
			var tgt_world: Vector3 = tgt_transform * te_pos
			var dist := sel_world.distance_to(tgt_world)
			if dist < best_dist:
				best_dist = dist
				snapped_sel_idx = si
				snapped_tgt_idx = ti

	var other_sel_idx := 1 - snapped_sel_idx
	return [sel_ends[other_sel_idx], tgt_ends[snapped_tgt_idx]]



static func _is_output_end(conveyor: Node3D, end_info: Dictionary) -> bool:
	if _is_curved_conveyor(conveyor):
		var prop := get_reverse_property_name(conveyor)
		var reversed: bool = bool(conveyor.get(prop)) if prop != &"" else false
		return (end_info.name == "head") != reversed
	return end_info.name == "front"


static func get_reverse_property_name(conveyor: Node3D) -> StringName:
	if conveyor != null and "reverse" in conveyor:
		return &"reverse"
	return &""


static func _find_closest_free_end_pair(
	selected_conveyor: Node3D, target_conveyor: Node3D, gap: float
) -> Dictionary:
	var sel_ends := _get_end_info(selected_conveyor)
	var tgt_ends := _get_end_info(target_conveyor)
	var sel_transform := get_selected_xform(selected_conveyor)

	var best_pair: Array[Dictionary]
	var best_compatible: bool = false
	var best_dist := INF

	for se_idx in range(sel_ends.size()):
		var se := sel_ends[se_idx]
		var other_se := sel_ends[1 - se_idx]
		var free_end_before: Vector3 = sel_transform * other_se.pos
		var se_is_output := _is_output_end(selected_conveyor, se)

		for te in tgt_ends:
			var snap_t := _snap_end_to_end(selected_conveyor, se, target_conveyor, te, gap)
			var free_end_after: Vector3 = snap_t * other_se.pos
			var dist := free_end_before.distance_to(free_end_after)
			if dist < best_dist:
				best_dist = dist
				best_pair = [se, te]
				best_compatible = se_is_output != _is_output_end(target_conveyor, te)

	return {"pair": best_pair, "needs_reverse": not best_compatible}


static func _calculate_curved_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D, live_mode: bool = false) -> Dictionary:
	if _is_straight_conveyor(target_conveyor) and _is_straight_conveyor(selected_conveyor):
		return ConveyorSnapFeatures.try_snap(selected_conveyor, target_conveyor, live_mode)

	var gap := _get_snap_gap(selected_conveyor, target_conveyor)

	var info := _find_closest_free_end_pair(selected_conveyor, target_conveyor, gap)
	var pair: Array[Dictionary] = info.pair
	var needs_reverse: bool = info.needs_reverse
	# No-op flip cycles end pair when snap matches current pose; suppressed in live (oscillates).
	if not live_mode:
		var snap_t := _snap_end_to_end(selected_conveyor, pair[0], target_conveyor, pair[1], gap)
		var current := get_selected_xform(selected_conveyor)
		if current.origin.distance_to(snap_t.origin) < 0.01 and current.basis.x.dot(snap_t.basis.x) > 0.999:
			pair = _find_resnap_end_pair(selected_conveyor, target_conveyor)
			var se_is_output := _is_output_end(selected_conveyor, pair[0])
			needs_reverse = se_is_output == _is_output_end(target_conveyor, pair[1])

	var snap_transform := _snap_end_to_end(selected_conveyor, pair[0], target_conveyor, pair[1], gap)
	var result := _make_snap_result(snap_transform, pair[0], pair[1])
	result["needs_reverse"] = needs_reverse
	return result


static func _calculate_spur_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D, live_mode: bool = false) -> Dictionary:
	var sel_transform := get_selected_xform(selected_conveyor)
	var tgt_transform := target_conveyor.global_transform
	var tgt_size := _get_conveyor_size(target_conveyor)
	var x_bounds := _get_conveyor_x_bounds(target_conveyor)
	var selected_position := sel_transform.origin

	var target_front := tgt_transform.origin + tgt_transform.basis.x * x_bounds.y
	var target_back := tgt_transform.origin + tgt_transform.basis.x * x_bounds.x

	var left_edge_start := tgt_transform.origin - tgt_transform.basis.z * (tgt_size.z / 2.0) + tgt_transform.basis.x * x_bounds.x
	var left_edge_end := tgt_transform.origin - tgt_transform.basis.z * (tgt_size.z / 2.0) + tgt_transform.basis.x * x_bounds.y
	var left_closest := _get_closest_point_on_line_segment(selected_position, left_edge_start, left_edge_end)

	var right_edge_start := tgt_transform.origin + tgt_transform.basis.z * (tgt_size.z / 2.0) + tgt_transform.basis.x * x_bounds.x
	var right_edge_end := tgt_transform.origin + tgt_transform.basis.z * (tgt_size.z / 2.0) + tgt_transform.basis.x * x_bounds.y
	var right_closest := _get_closest_point_on_line_segment(selected_position, right_edge_start, right_edge_end)

	var dist_front := selected_position.distance_to(target_front)
	var dist_back := selected_position.distance_to(target_back)
	var dist_left := selected_position.distance_to(left_closest)
	var dist_right := selected_position.distance_to(right_closest)

	var min_end_dist: float = min(dist_front, dist_back)
	var min_side_dist: float = min(dist_left, dist_right)

	if min_end_dist < min_side_dist:
		return ConveyorSnapFeatures.try_snap(selected_conveyor, target_conveyor, live_mode)

	var side_outward: Vector3
	var side_edge_start: Vector3
	var side_edge_end: Vector3
	if dist_left < dist_right:
		side_outward = Vector3(0, 0, -1)
		side_edge_start = left_edge_start
		side_edge_end = left_edge_end
	else:
		side_outward = Vector3(0, 0, 1)
		side_edge_start = right_edge_start
		side_edge_end = right_edge_end

	var sel_ends := _get_spur_end_info(selected_conveyor)
	var best_sel: Dictionary = sel_ends[0]
	var best_dist := INF
	for se in sel_ends:
		var se_world: Vector3 = sel_transform * (se.pos as Vector3)
		var side_closest := _get_closest_point_on_line_segment(se_world, side_edge_start, side_edge_end)
		var dist := se_world.distance_to(side_closest)
		if dist < best_dist:
			best_dist = dist
			best_sel = se

	var best_sel_world: Vector3 = sel_transform * (best_sel.pos as Vector3)
	var side_contact := _get_closest_point_on_line_segment(best_sel_world, side_edge_start, side_edge_end)
	var side_pos_local: Vector3 = tgt_transform.affine_inverse() * side_contact
	var side_name: StringName = &"left_side" if dist_left < dist_right else &"right_side"
	var side_end := {"pos": side_pos_local, "outward": side_outward, "name": side_name}

	# Belt spurs clear the belt's frame flange (FLANGE_WIDTH * 2). Roller spurs need more
	# room for the end pulley.
	var spur_gap := ConveyorFrameMesh.FLANGE_WIDTH * 2.0
	if not "conveyor_count" in selected_conveyor:
		spur_gap = 0.12

	var snap_transform := _snap_end_to_end(selected_conveyor, best_sel, target_conveyor, side_end, spur_gap)
	return _make_snap_result(snap_transform, best_sel, side_end)


static func _calculate_snap_to_spur_target_transform(selected_conveyor: Node3D, target_spur: Node3D, live_mode: bool = false) -> Dictionary:
	var sel_transform := get_selected_xform(selected_conveyor)
	var tgt_transform := target_spur.global_transform
	var tgt_size := _get_conveyor_size(target_spur)
	var x_bounds := _get_conveyor_x_bounds(target_spur)
	var selected_position := sel_transform.origin

	var tgt_ends := _get_spur_end_info(target_spur)
	var tgt_front_world: Vector3 = tgt_transform * (tgt_ends[0].pos as Vector3)
	var tgt_back_world: Vector3 = tgt_transform * (tgt_ends[1].pos as Vector3)

	var left_edge_start := tgt_transform.origin - tgt_transform.basis.z * (tgt_size.z / 2.0) + tgt_transform.basis.x * x_bounds.x
	var left_edge_end := tgt_transform.origin - tgt_transform.basis.z * (tgt_size.z / 2.0) + tgt_transform.basis.x * x_bounds.y
	var left_closest := _get_closest_point_on_line_segment(selected_position, left_edge_start, left_edge_end)

	var right_edge_start := tgt_transform.origin + tgt_transform.basis.z * (tgt_size.z / 2.0) + tgt_transform.basis.x * x_bounds.x
	var right_edge_end := tgt_transform.origin + tgt_transform.basis.z * (tgt_size.z / 2.0) + tgt_transform.basis.x * x_bounds.y
	var right_closest := _get_closest_point_on_line_segment(selected_position, right_edge_start, right_edge_end)

	var dist_front := selected_position.distance_to(tgt_front_world)
	var dist_back := selected_position.distance_to(tgt_back_world)
	var dist_left := selected_position.distance_to(left_closest)
	var dist_right := selected_position.distance_to(right_closest)

	var min_end_dist: float = min(dist_front, dist_back)
	var min_side_dist: float = min(dist_left, dist_right)

	if min_end_dist > min_side_dist:
		return ConveyorSnapFeatures.try_snap(selected_conveyor, target_spur, live_mode)

	var best_tgt: Dictionary = tgt_ends[0] if dist_front < dist_back else tgt_ends[1]
	var best_tgt_world: Vector3 = tgt_transform * (best_tgt.pos as Vector3)

	var sel_ends := _get_straight_end_info(selected_conveyor)
	var best_sel: Dictionary = sel_ends[0]
	var best_dist := INF
	for se in sel_ends:
		var se_world: Vector3 = sel_transform * (se.pos as Vector3)
		var dist := se_world.distance_to(best_tgt_world)
		if dist < best_dist:
			best_dist = dist
			best_sel = se

	var snap_transform := _snap_end_to_end(selected_conveyor, best_sel, target_spur, best_tgt, 0.0)
	return _make_snap_result(snap_transform, best_sel, best_tgt)


static func _is_straight_conveyor(conveyor: Node3D) -> bool:
	if not live_type_cache.is_empty():
		var f: Variant = live_type_cache.get(conveyor.get_instance_id())
		if f != null:
			return f.is_straight
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()

	var straight_types := [
		"BeltConveyor", "BeltSpurConveyor",
		"RollerConveyor",
		"RollerSpurConveyor"
	]

	return global_name in straight_types or node_class in straight_types


static func _is_diverter(node: Node) -> bool:
	return node is Diverter


static func _is_chain_transfer(node: Node) -> bool:
	return node is ChainTransfer


static func _is_blade_stop(node: Node) -> bool:
	return node is BladeStop


static func _is_roller_conveyor(node: Node) -> bool:
	return node is RollerConveyor


static func _open_side_guards_for_diverter(undo_redo: EditorUndoRedoManager, snap_transform: Transform3D, diverter: Node3D, target_conveyor: Node3D) -> void:
	var intersection_info := _calculate_diverter_intersection_for_transform(diverter, target_conveyor, snap_transform)
	_shrink_guards_for_gap(undo_redo, target_conveyor, intersection_info)
