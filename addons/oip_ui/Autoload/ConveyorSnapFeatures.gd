@tool
class_name ConveyorSnapFeatures
extends RefCounted

## Generic snap-feature matcher (POC).
##
## Parts opt in by implementing [code]get_snap_features() -> Array[/code] on
## their script. Each feature is a Dictionary describing a piece of geometry
## (POINT or SEGMENT) tagged with a [code]kind[/code] StringName. The matcher
## here finds the best (selected_feature, target_feature) pair according to a
## kind-compatibility table and a per-shape geometric aligner, then returns a
## snap result in the same format as ConveyorSnapping._make_snap_result.
##
## This file currently supports only the diverter -> conveyor-side case used
## by the POC: POINT (diverter push side) against SEGMENT (conveyor sideguard).
## Additional shapes (TRACK, ARC) and aligners will be added as more part
## types are migrated off the per-pair branches in ConveyorSnapping.gd.

const DIVERTER_Y_OFFSET: float = 0.2
const BLADE_STOP_TARGET_LOCAL_Y: float = -0.27
const CHAIN_TRANSFER_TARGET_LOCAL_Y: float = -0.05

enum Shape { POINT, SEGMENT, TRACK }


## Entry point. Tries to compute a snap transform via the feature model.
## Returns an empty Dictionary if no compatible feature pair exists; the
## caller should fall back to the legacy per-pair functions in that case.
##
## Features come from get_snap_features() on the node when present, otherwise
## from the centralised _compute_features_for fallback. The fallback covers
## conveyor types whose snap geometry is purely a function of [code]size[/code].
##
## [code]live_mode[/code] suppresses one-shot UX behaviours (currently the
## straight-to-straight no-op flip) so the matcher is idempotent — required
## by the live preview path which calls try_snap every frame and writes the
## result back to the selected node.
static func try_snap(selected: Node3D, target: Node3D, live_mode: bool = false) -> Dictionary:
	var sel_features: Array = _features_of(selected)
	var tgt_features: Array = _features_of(target)
	if sel_features.is_empty() or tgt_features.is_empty():
		return {}

	# Holistic dispatch: when both sides expose straight conveyor end POINTs,
	# use the dedicated straight-to-straight aligner instead of per-pair
	# scoring. This case carries cross-cutting concerns (perpendicularity
	# bias, flow-flip, no-op flip, inclination preservation) that don't
	# decompose cleanly into independent pair scores.
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


## Derive snap features from a node. Centralised fallback used when a node
## does not implement get_snap_features() itself. Future migrations will
## move these onto the individual scripts.
##
## Currently emits:
##   - Front/back end POINTs for straight conveyors (front = +X, back = -X)
##   - Left/right sideguard SEGMENTs for any node with a [code]size[/code]
##     property
##   - roller_gap_track and roller_on_track TRACKs along the X axis for
##     RollerConveyor and RollerConveyorAssembly targets
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

	# Roller-specific track of inter-roller gap positions along the belt X axis.
	# Mirrors ConveyorSnapping._calculate_blade_stop_snap_transform L1244-1255:
	# the first roller sits at (-size.x/2 + ROLLERS_START_OFFSET + rd) and gaps
	# fall halfway between consecutive rollers.
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
		# On-roller track: same axis and step but phased to land on roller
		# centers instead of between them. Used by chain transfers with an
		# even number of chains, where the array center sits on a roller.
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


## Score a candidate pair. Lower is better. For SEGMENT targets this reproduces
## the existing left-vs-right pick at ConveyorSnapping.gd:1271-1274 (compare to
## segment center). For TRACK targets the score is the distance from the
## selected anchor to the track line, so the matcher will prefer the unique
## roller_gap_track on a roller conveyor over any sideguard segment.
static func _score_pair(selected: Node3D, target: Node3D, sf: Dictionary, tf: Dictionary) -> float:
	if tf.shape == Shape.SEGMENT:
		var seg_center_local: Vector3 = (tf.seg_start + tf.seg_end) * 0.5
		var seg_center_world: Vector3 = target.global_transform * seg_center_local
		return ConveyorSnapping.get_selected_xform(selected).origin.distance_to(seg_center_world)
	if tf.shape == Shape.TRACK:
		var anchor_world: Vector3 = ConveyorSnapping.get_selected_xform(selected) * (sf.local_pos as Vector3)
		var anchor_local: Vector3 = target.global_transform.affine_inverse() * anchor_world
		# Distance from anchor to the track line, ignoring its position along
		# the axis. Track currently lies at Y=0, Z=0 in target local frame.
		var perp: Vector2 = Vector2(anchor_local.y, anchor_local.z)
		return perp.length()
	return INF


static func _align(selected: Node3D, target: Node3D, sf: Dictionary, tf: Dictionary) -> Dictionary:
	if sf.shape == Shape.POINT and tf.shape == Shape.SEGMENT:
		return _align_point_to_segment(selected, target, sf, tf)
	if sf.shape == Shape.POINT and tf.shape == Shape.TRACK:
		return _align_point_to_track(selected, target, sf, tf)
	return {}


## POINT-on-selected aligned onto SEGMENT-on-target.
##
## Geometry follows the existing diverter snap at ConveyorSnapping.gd:1264-1300:
##   1. Project selected origin onto the target side segment to get the contact point.
##   2. Build a new basis whose X is the target's X (axis lock) and whose Z is
##      the segment's outward normal expressed in world space.
##   3. Place the selected so its [code]local_pos[/code] coincides with the
##      contact point, then drop by [code]y_offset[/code] along the new Y.
static func _align_point_to_segment(selected: Node3D, target: Node3D, sf: Dictionary, tf: Dictionary) -> Dictionary:
	var target_xform: Transform3D = target.global_transform
	var seg_start_world: Vector3 = target_xform * tf.seg_start
	var seg_end_world: Vector3 = target_xform * tf.seg_end
	var contact: Vector3 = _closest_point_on_segment(
		ConveyorSnapping.get_selected_xform(selected).origin, seg_start_world, seg_end_world
	)

	# side_sign comes from the segment's outward normal in target-local space.
	# For a left side this is -1, for a right side it is +1.
	var side_sign: float = signf(tf.seg_outward_local.z)
	if side_sign == 0.0:
		side_sign = 1.0

	# Build a proper right-handed rotation. Flipping only Z (as the legacy
	# diverter snap did) produces a reflection, which inverts Y and makes the
	# selected node appear upside down on the opposite side. Flipping X and Z
	# together is a 180° rotation around Y, keeping the part upright on both
	# sides while still pointing its push face inward toward the segment.
	var new_basis: Basis = Basis()
	new_basis.x = side_sign * target_xform.basis.x.normalized()
	new_basis.z = side_sign * target_xform.basis.z.normalized()
	new_basis.y = target_xform.basis.y.normalized()

	# Place the selected so that its local feature point lands on the contact.
	# selected.global_origin = contact - new_basis * sf.local_pos, then apply
	# the per-feature vertical drop along the new Y axis.
	var origin: Vector3 = contact - new_basis * (sf.local_pos as Vector3)
	var y_offset: float = float(sf.get(&"y_offset", 0.0))
	origin -= new_basis.y * y_offset

	var snap_transform: Transform3D = Transform3D(new_basis, origin)

	# Build snap_result in the format ConveyorSnapping._make_snap_result produces,
	# so the caller's post-snap pipeline (sideguard opener / connector) is unchanged.
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


## POINT-on-selected aligned to a discrete TRACK on the target.
##
## Generalised from the legacy blade-stop snap at ConveyorSnapping.gd:1236-1270
## and chain-transfer snap at L1202-1232. Steps:
##   1. Express the selected anchor (sf.local_pos in selected-local) in target-local.
##   2. Project onto the track axis and round to the nearest sample (phase + n*step),
##      clamping n into [n_min, n_max]. Bounds are tightened by sf.track_extent
##      to keep the selected part's footprint along the axis inside the track.
##   3. Place the selected so its anchor lands on the snapped sample, with the
##      result origin sitting at sf.target_local_y in target local Y.
##   4. New basis = orthonormalised target basis pre-multiplied by sf.local_basis_rotation
##      (defaults to identity), scaled by the selected's own scale to preserve
##      any non-uniform sizing on the selected node. The rotation is what lets
##      a chain transfer sit perpendicular to the conveyor axis (90° around Y).
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

	# Selected origin in target-local. After applying local_basis_rotation, the
	# selected-local point local_pos lands at (rotation * local_pos) in
	# target-local, so origin = anchor_target_local - rotation * local_pos.
	var target_local_y: float = float(sf.get(&"target_local_y", 0.0))
	var anchor_target_local: Vector3 = axis * snapped_axis + Vector3(0, target_local_y, 0)
	var rotated_local_pos: Vector3 = local_basis_rotation * local_pos
	var origin_target_local: Vector3 = anchor_target_local - rotated_local_pos
	var origin_world: Vector3 = target_xform * origin_target_local

	var tgt_basis: Basis = target_xform.basis.orthonormalized() * local_basis_rotation
	var sel_scale: Vector3 = selected.scale
	var new_basis: Basis = Basis(
		tgt_basis.x * sel_scale.x,
		tgt_basis.y * sel_scale.y,
		tgt_basis.z * sel_scale.z,
	)

	# Blade stop and chain transfer paths in the legacy code return only
	# {transform, is_end_to_end} (no snapped_end / target_end), bypassing
	# _make_snap_result. Mirror that here so the orchestrator's post-snap
	# pipeline behaves identically.
	return {
		"transform": Transform3D(new_basis, origin_world),
		"is_end_to_end": false,
	}


## Holistic straight-to-straight aligner.
##
## Mirrors the legacy ConveyorSnapping._calculate_regular_snap_transform at
## L1073-1173 but reads geometry from the feature lists instead of recomputing
## edge positions inline. The legacy logic carries several cross-cutting
## concerns that don't decompose cleanly into per-pair scoring:
##   - Distance pick over the four target edges (front/back POINTs, left/right SEGMENTs)
##   - Perpendicularity heuristic (L1099-1106): when conveyors are nearly perpendicular,
##     bias toward side connections unless an end is much closer
##   - Inclination preservation: keep the selected's Z inclination on the new basis
##   - Flow-flip post-process (L1162-1166): if the snap would invert the selected's
##     forward direction, rotate 180° around local Y to preserve flow
##   - No-op flip (L1167-1171): if the snap matches the selected's current pose,
##     flip 180° around Y so consecutive snaps actually move the part
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

	# Perpendicularity heuristic mirrors L1093-1106. When the two forwards are
	# nearly perpendicular, prefer side connections unless an end is markedly closer.
	var sel_forward: Vector3 = sel_xform.basis.x.normalized()
	var tgt_forward: Vector3 = tgt_xform.basis.x.normalized()
	var dot_product: float = absf(sel_forward.dot(tgt_forward))
	var is_perpendicular: bool = dot_product < 0.7

	var min_distance: float = minf(minf(dist_front, dist_back), minf(dist_left, dist_right))
	if is_perpendicular:
		var min_side: float = minf(dist_left, dist_right)
		var min_end: float = minf(dist_front, dist_back)
		if min_end < 0.5 and min_end < min_side * 0.2:
			min_distance = min_end
		else:
			min_distance = min_side

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

	# Flow-flip: if the snap would invert the selected's forward, rotate 180°
	# around local Y so the flow direction is preserved.
	if sel_xform.basis.x.dot(snap_transform.basis.x) < 0.0:
		var flipped: Array = _flip_around_local_y(snap_transform, snapped_end)
		snap_transform = flipped[0]
		snapped_end = flipped[1]

	# No-op flip: if the snap matches the current pose, flip so the user sees
	# something change. Suppressed in live mode because the live preview writes
	# the snap pose every frame, which would otherwise cause this to oscillate
	# the part 180° around Y indefinitely while the modifier is held.
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
