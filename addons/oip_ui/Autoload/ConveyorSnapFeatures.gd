@tool
class_name ConveyorSnapFeatures
extends RefCounted

## Generic snap-feature matcher. Parts opt in via [code]get_snap_features()[/code].

const DIVERTER_Y_OFFSET: float = 0.2
## Recess from belt edge so the push face stays out of the flow path.
const DIVERTER_SIDE_OFFSET: float = 0.05
const BLADE_STOP_TARGET_LOCAL_Y: float = -0.27
const CHAIN_TRANSFER_TARGET_LOCAL_Y: float = -0.05

enum Shape { POINT, SEGMENT, TRACK }


## [code]live_mode[/code] makes try_snap idempotent for per-frame preview calls.
static func try_snap(
	selected: Node3D, target: Node3D, live_mode: bool = false,
	sel_features_in: Variant = null, tgt_features_in: Variant = null,
) -> Dictionary:
	var sel_features: Array = sel_features_in if sel_features_in != null else _features_of(selected)
	var tgt_features: Array = tgt_features_in if tgt_features_in != null else _features_of(target)
	if sel_features.is_empty() or tgt_features.is_empty():
		return {}

	if _has_kind(sel_features, &"straight_end_front") and _has_kind(tgt_features, &"straight_end_front"):
		return _align_straight_to_straight(selected, target, sel_features, tgt_features, live_mode)

	var best: Dictionary = {}
	var best_score: float = INF
	for sf in sel_features:
		for tf in tgt_features:
			if not _kinds_compatible(sf.kind, tf.kind):
				continue
			var score: float = _score_pair(selected, target, sf, tf)
			if score < best_score:
				best_score = score
				best = {"sel": sf, "tgt": tf}

	if best.is_empty():
		return {}

	return _align(selected, target, best.sel, best.tgt)


static func _features_of(node: Node3D) -> Array:
	if node.has_method(&"get_snap_features"):
		return node.get_snap_features()
	return _compute_features_for(node)


static func _has_kind(features: Array, kind: StringName) -> bool:
	for f in features:
		if f.kind == kind:
			return true
	return false


static func _find_by_kind(features: Array, kind: StringName) -> Dictionary:
	for f in features:
		if f.kind == kind:
			return f
	return {}


static func _compute_features_for(node: Node3D) -> Array:
	if not (&"size" in node):
		return []
	var size: Vector3 = node.size
	var hl: float = size.x / 2.0
	var hw: float = size.z / 2.0
	var features: Array = [
		{
			"shape": Shape.POINT,
			"kind": &"straight_end_front",
			"local_pos": Vector3(hl, 0, 0),
			"local_outward": Vector3(1, 0, 0),
			"end_name": &"front",
		},
		{
			"shape": Shape.POINT,
			"kind": &"straight_end_back",
			"local_pos": Vector3(-hl, 0, 0),
			"local_outward": Vector3(-1, 0, 0),
			"end_name": &"back",
		},
		{
			"shape": Shape.SEGMENT,
			"kind": &"straight_sideguard_left",
			"seg_start": Vector3(-hl, 0, -hw),
			"seg_end": Vector3(hl, 0, -hw),
			"seg_outward_local": Vector3(0, 0, -1),
		},
		{
			"shape": Shape.SEGMENT,
			"kind": &"straight_sideguard_right",
			"seg_start": Vector3(-hl, 0, hw),
			"seg_end": Vector3(hl, 0, hw),
			"seg_outward_local": Vector3(0, 0, 1),
		},
	]

	# Roller-specific tracks: gap_track lands between rollers, on_track on centers.
	if node is RollerConveyor or node is RollerConveyorAssembly:
		var rd: float = Rollers.ROLLERS_DISTANCE
		var first_roller_x: float = -hl + Rollers.ROLLERS_START_OFFSET + rd
		var gap_phase: float = first_roller_x + rd / 2.0
		var usable_half: float = hl - Rollers.ROLLERS_START_OFFSET
		features.append({
			"shape": Shape.TRACK,
			"kind": &"roller_gap_track",
			"axis_local": Vector3(1, 0, 0),
			"phase": gap_phase,
			"step": rd,
			"x_min": -usable_half,
			"x_max": usable_half,
		})
		features.append({
			"shape": Shape.TRACK,
			"kind": &"roller_on_track",
			"axis_local": Vector3(1, 0, 0),
			"phase": first_roller_x,
			"step": rd,
			"x_min": -usable_half,
			"x_max": usable_half,
		})
	return features


static func _kinds_compatible(sel_kind: StringName, tgt_kind: StringName) -> bool:
	if sel_kind == &"diverter_push_side":
		return tgt_kind == &"straight_sideguard_left" or tgt_kind == &"straight_sideguard_right"
	if sel_kind == &"blade_anchor":
		return tgt_kind == &"roller_gap_track"
	if sel_kind == &"chain_transfer_anchor_gap":
		return tgt_kind == &"roller_gap_track"
	if sel_kind == &"chain_transfer_anchor_on":
		return tgt_kind == &"roller_on_track"
	return false


static func _score_pair(selected: Node3D, target: Node3D, sf: Dictionary, tf: Dictionary) -> float:
	if tf.shape == Shape.SEGMENT:
		var seg_center_local: Vector3 = (tf.seg_start + tf.seg_end) * 0.5
		var seg_center_world: Vector3 = target.global_transform * seg_center_local
		return ConveyorSnapping.get_selected_xform(selected).origin.distance_to(seg_center_world)
	if tf.shape == Shape.TRACK:
		var anchor_world: Vector3 = ConveyorSnapping.get_selected_xform(selected) * (sf.local_pos as Vector3)
		var anchor_local: Vector3 = target.global_transform.affine_inverse() * anchor_world
		# Track lies at Y=0, Z=0 in target local frame.
		var perp: Vector2 = Vector2(anchor_local.y, anchor_local.z)
		return perp.length()
	return INF


static func _align(selected: Node3D, target: Node3D, sf: Dictionary, tf: Dictionary) -> Dictionary:
	if sf.shape == Shape.POINT and tf.shape == Shape.SEGMENT:
		return _align_point_to_segment(selected, target, sf, tf)
	if sf.shape == Shape.POINT and tf.shape == Shape.TRACK:
		return _align_point_to_track(selected, target, sf, tf)
	return {}


static func _align_point_to_segment(selected: Node3D, target: Node3D, sf: Dictionary, tf: Dictionary) -> Dictionary:
	var target_xform: Transform3D = target.global_transform
	var seg_start_world: Vector3 = target_xform * tf.seg_start
	var seg_end_world: Vector3 = target_xform * tf.seg_end
	var contact: Vector3 = _closest_point_on_segment(
		ConveyorSnapping.get_selected_xform(selected).origin, seg_start_world, seg_end_world
	)

	var side_sign: float = signf(tf.seg_outward_local.z)
	if side_sign == 0.0:
		side_sign = 1.0

	# Flip both X and Z (180° around Y); flipping Z alone would reflect/invert Y.
	var new_basis: Basis = Basis()
	new_basis.x = side_sign * target_xform.basis.x.normalized()
	new_basis.z = side_sign * target_xform.basis.z.normalized()
	new_basis.y = target_xform.basis.y.normalized()

	var origin: Vector3 = contact - new_basis * (sf.local_pos as Vector3)
	var y_offset: float = float(sf.get(&"y_offset", 0.0))
	origin -= new_basis.y * y_offset
	var outward_offset: float = float(sf.get(&"outward_offset", 0.0))
	if outward_offset != 0.0:
		var outward_world: Vector3 = (target_xform.basis * (tf.seg_outward_local as Vector3)).normalized()
		origin += outward_world * outward_offset

	var snap_transform: Transform3D = Transform3D(new_basis, origin)

	var contact_local: Vector3 = target_xform.affine_inverse() * contact
	var snapped_end: Dictionary = {
		"pos": sf.local_pos,
		"outward": sf.local_outward,
		"name": sf.get(&"end_name", &"feature"),
	}
	var target_end: Dictionary = {
		"pos": contact_local,
		"outward": Vector3(0, 0, side_sign),
		"name": (&"left_side" if side_sign < 0.0 else &"right_side"),
	}
	var end_names: Array = [&"front", &"back", &"head", &"tail"]
	return {
		"transform": snap_transform,
		"snapped_end": snapped_end,
		"target_end": target_end,
		"is_end_to_end": snapped_end.name in end_names and target_end.name in end_names,
	}


static func _align_point_to_track(selected: Node3D, target: Node3D, sf: Dictionary, tf: Dictionary) -> Dictionary:
	var target_xform: Transform3D = target.global_transform
	var local_pos: Vector3 = sf.local_pos
	var local_basis_rotation: Basis = sf.get(&"local_basis_rotation", Basis())
	var anchor_world: Vector3 = ConveyorSnapping.get_selected_xform(selected) * local_pos
	var anchor_local: Vector3 = target_xform.affine_inverse() * anchor_world

	var axis: Vector3 = (tf.axis_local as Vector3).normalized()
	var phase: float = tf.phase
	var step: float = tf.step
	var track_extent: float = float(sf.get(&"track_extent", 0.0))
	var x_min: float = tf.x_min + track_extent
	var x_max: float = tf.x_max - track_extent

	var anchor_axis: float = anchor_local.dot(axis)
	var n: int = roundi((anchor_axis - phase) / step)
	var n_min: int = ceili((x_min - phase) / step)
	var n_max: int = floori((x_max - phase) / step)
	if n_max >= n_min:
		n = clampi(n, n_min, n_max)
	var snapped_axis: float = phase + float(n) * step

	var target_local_y: float = float(sf.get(&"target_local_y", 0.0))
	var anchor_target_local: Vector3 = axis * snapped_axis + Vector3(0, target_local_y, 0)
	var rotated_local_pos: Vector3 = local_basis_rotation * local_pos
	var origin_target_local: Vector3 = anchor_target_local - rotated_local_pos
	var origin_world: Vector3 = target_xform * origin_target_local

	var tgt_basis: Basis = target_xform.basis.orthonormalized() * local_basis_rotation
	var sel_scale: Vector3 = selected.scale
	# Auto-fit Z to target belt width. native_z_width is the part's extent at scale.z=1.
	if sf.get(&"auto_fit_target_width", false) and &"size" in target:
		var native_z_width: float = float(sf.get(&"native_z_width", 1.0))
		if native_z_width > 0.0:
			var target_z: float = (target.size as Vector3).z
			sel_scale.z = target_z / native_z_width
	var new_basis: Basis = Basis(
		tgt_basis.x * sel_scale.x,
		tgt_basis.y * sel_scale.y,
		tgt_basis.z * sel_scale.z,
	)

	# On-top attachments: no snapped_end / target_end, so guard-opening doesn't apply.
	var result: Dictionary = {
		"transform": Transform3D(new_basis, origin_world),
		"is_end_to_end": false,
	}
	# Scale must be a side effect: fork orthonormalizes the returned basis on drop hover.
	if sf.get(&"auto_fit_target_width", false):
		result["scale"] = sel_scale
	if sf.has(&"visible_threshold"):
		result["visible_threshold"] = sf.visible_threshold
	return result


static func _align_straight_to_straight(
	selected: Node3D, target: Node3D,
	sel_features: Array, tgt_features: Array,
	live_mode: bool = false
) -> Dictionary:
	var sel_xform: Transform3D = ConveyorSnapping.get_selected_xform(selected)
	var tgt_xform: Transform3D = target.global_transform
	var sel_origin: Vector3 = sel_xform.origin

	var tgt_front: Dictionary = _find_by_kind(tgt_features, &"straight_end_front")
	var tgt_back: Dictionary = _find_by_kind(tgt_features, &"straight_end_back")
	var tgt_left: Dictionary = _find_by_kind(tgt_features, &"straight_sideguard_left")
	var tgt_right: Dictionary = _find_by_kind(tgt_features, &"straight_sideguard_right")
	var sel_front: Dictionary = _find_by_kind(sel_features, &"straight_end_front")
	var sel_back: Dictionary = _find_by_kind(sel_features, &"straight_end_back")
	if tgt_front.is_empty() or tgt_back.is_empty() or sel_front.is_empty() or sel_back.is_empty():
		return {}

	var tgt_front_world: Vector3 = tgt_xform * (tgt_front.local_pos as Vector3)
	var tgt_back_world: Vector3 = tgt_xform * (tgt_back.local_pos as Vector3)
	var left_start_world: Vector3 = tgt_xform * (tgt_left.seg_start as Vector3)
	var left_end_world: Vector3 = tgt_xform * (tgt_left.seg_end as Vector3)
	var right_start_world: Vector3 = tgt_xform * (tgt_right.seg_start as Vector3)
	var right_end_world: Vector3 = tgt_xform * (tgt_right.seg_end as Vector3)
	var left_center_world: Vector3 = (left_start_world + left_end_world) * 0.5
	var right_center_world: Vector3 = (right_start_world + right_end_world) * 0.5

	var dist_front: float = sel_origin.distance_to(tgt_front_world)
	var dist_back: float = sel_origin.distance_to(tgt_back_world)
	var dist_left: float = sel_origin.distance_to(left_center_world)
	var dist_right: float = sel_origin.distance_to(right_center_world)

	# Prefer the mode that preserves facing unless the other is much closer.
	# Perpendicular: side preserves facing. Parallel: end preserves facing.
	var sel_forward: Vector3 = sel_xform.basis.x.normalized()
	var tgt_forward: Vector3 = tgt_xform.basis.x.normalized()
	var dot_product: float = absf(sel_forward.dot(tgt_forward))
	var is_perpendicular: bool = dot_product < 0.7

	var min_side: float = minf(dist_left, dist_right)
	var min_end: float = minf(dist_front, dist_back)
	var min_distance: float
	if is_perpendicular:
		if min_end < 0.5 and min_end < min_side * 0.2:
			min_distance = min_end
		else:
			min_distance = min_side
	else:
		if min_side < 0.5 and min_side < min_end * 0.2:
			min_distance = min_side
		else:
			min_distance = min_end

	var sel_inclination: float = _z_inclination(sel_xform)
	var sel_size_x: float = _conveyor_size_x(selected)

	var snap_transform: Transform3D = Transform3D()
	var snapped_end: Dictionary = {}
	var target_end: Dictionary = {}

	if min_distance == dist_front:
		var new_basis: Basis = _apply_inclination(tgt_xform.basis, sel_inclination)
		snap_transform.basis = new_basis
		snap_transform.origin = tgt_front_world + new_basis.x * (sel_size_x / 2.0)
		snapped_end = {"pos": Vector3(-sel_size_x / 2.0, 0, 0), "outward": Vector3(-1, 0, 0), "name": &"back"}
		target_end = {"pos": tgt_front.local_pos, "outward": Vector3(1, 0, 0), "name": &"front"}
	elif min_distance == dist_back:
		var new_basis: Basis = _apply_inclination(tgt_xform.basis, sel_inclination)
		snap_transform.basis = new_basis
		snap_transform.origin = tgt_back_world - new_basis.x * (sel_size_x / 2.0)
		snapped_end = {"pos": Vector3(sel_size_x / 2.0, 0, 0), "outward": Vector3(1, 0, 0), "name": &"front"}
		target_end = {"pos": tgt_back.local_pos, "outward": Vector3(-1, 0, 0), "name": &"back"}
	elif min_distance == dist_left:
		var contact: Vector3 = _closest_point_on_segment(sel_origin, left_start_world, left_end_world)
		var perp_basis: Basis = Basis()
		perp_basis.x = tgt_xform.basis.z
		perp_basis.y = tgt_xform.basis.y
		perp_basis.z = -tgt_xform.basis.x
		var new_basis: Basis = _apply_inclination(perp_basis, sel_inclination)
		snap_transform.basis = new_basis
		snap_transform.origin = contact - new_basis.x * (sel_size_x / 2.0)
		var contact_local: Vector3 = tgt_xform.affine_inverse() * contact
		snapped_end = {"pos": Vector3(sel_size_x / 2.0, 0, 0), "outward": Vector3(1, 0, 0), "name": &"front"}
		target_end = {"pos": contact_local, "outward": Vector3(0, 0, -1), "name": &"left_side"}
	else:
		var contact: Vector3 = _closest_point_on_segment(sel_origin, right_start_world, right_end_world)
		var perp_basis: Basis = Basis()
		perp_basis.x = -tgt_xform.basis.z
		perp_basis.y = tgt_xform.basis.y
		perp_basis.z = tgt_xform.basis.x
		var new_basis: Basis = _apply_inclination(perp_basis, sel_inclination)
		snap_transform.basis = new_basis
		snap_transform.origin = contact - new_basis.x * (sel_size_x / 2.0)
		var contact_local: Vector3 = tgt_xform.affine_inverse() * contact
		snapped_end = {"pos": Vector3(sel_size_x / 2.0, 0, 0), "outward": Vector3(1, 0, 0), "name": &"front"}
		target_end = {"pos": contact_local, "outward": Vector3(0, 0, 1), "name": &"right_side"}

	# Flow-flip: preserve forward direction by rotating 180° around Y if inverted.
	if sel_xform.basis.x.dot(snap_transform.basis.x) < 0.0:
		var flipped: Array = _flip_around_local_y(snap_transform, snapped_end)
		snap_transform = flipped[0]
		snapped_end = flipped[1]

	# No-op flip: visible feedback when snap matches current pose. Suppressed in live (oscillates).
	if not live_mode:
		var current: Transform3D = sel_xform
		if current.origin.distance_to(snap_transform.origin) < 0.01 and current.basis.x.dot(snap_transform.basis.x) > 0.999:
			var flipped: Array = _flip_around_local_y(snap_transform, snapped_end)
			snap_transform = flipped[0]
			snapped_end = flipped[1]

	var end_names: Array = [&"front", &"back", &"head", &"tail"]
	return {
		"transform": snap_transform,
		"snapped_end": snapped_end,
		"target_end": target_end,
		"is_end_to_end": snapped_end.name in end_names and target_end.name in end_names,
	}


static func _conveyor_size_x(node: Node3D) -> float:
	if &"size" in node:
		return (node.size as Vector3).x
	return 4.0


static func _z_inclination(xform: Transform3D) -> float:
	var forward: Vector3 = xform.basis.x.normalized()
	return atan2(forward.y, Vector2(forward.x, forward.z).length())


static func _apply_inclination(basis: Basis, inclination: float) -> Basis:
	var horizontal_forward: Vector3 = Vector3(basis.x.x, 0, basis.x.z).normalized()
	var horizontal_right: Vector3 = Vector3(basis.z.x, 0, basis.z.z).normalized()
	var inclined_forward: Vector3 = horizontal_forward * cos(inclination) + Vector3.UP * sin(inclination)
	var new_basis: Basis = Basis()
	new_basis.x = inclined_forward
	new_basis.z = horizontal_right
	new_basis.y = new_basis.z.cross(new_basis.x).normalized()
	return new_basis


static func _flip_around_local_y(snap_transform: Transform3D, snapped_end: Dictionary) -> Array:
	var flipped_transform: Transform3D = snap_transform
	flipped_transform.basis = Basis(-snap_transform.basis.x, snap_transform.basis.y, -snap_transform.basis.z)
	var name_map: Dictionary = {&"front": &"back", &"back": &"front"}
	var new_name: StringName = name_map.get(snapped_end.name, snapped_end.name)
	var flipped_end: Dictionary = {
		"pos": -(snapped_end.pos as Vector3),
		"outward": -(snapped_end.outward as Vector3),
		"name": new_name,
	}
	return [flipped_transform, flipped_end]


static func _closest_point_on_segment(point: Vector3, line_start: Vector3, line_end: Vector3) -> Vector3:
	var line_vector: Vector3 = line_end - line_start
	var line_length_squared: float = line_vector.length_squared()
	if line_length_squared == 0.0:
		return line_start
	var t: float = (point - line_start).dot(line_vector) / line_length_squared
	t = clampf(t, 0.0, 1.0)
	return line_start + t * line_vector
