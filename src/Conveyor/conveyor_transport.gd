@tool
class_name ConveyorTransport
extends RefCounted

const SURFACE_GROUP := &"conveyor_surface"
const DRIVE_MAX_ACCEL := 25.0
const SAMPLES_ALONG := 5
const RAY_UP := 0.05
const RAY_DOWN := 0.15

static var enabled := true
static var debug := false
static var debug_interval_ms := 150

static var _next_log: Dictionary = {}
static var _query: PhysicsRayQueryParameters3D


static func drive_body(body: RigidBody3D, footprint: Vector3, delta: float) -> void:
	if not enabled or body == null or body.freeze or delta <= 0.0:
		return
	var world := body.get_world_3d()
	if world == null:
		return
	var space := world.direct_space_state
	if space == null:
		return

	var xform := body.global_transform
	var up := xform.basis.y.normalized()
	var half := footprint * 0.5
	var flow_sum := Vector3.ZERO
	var hits := 0
	var smin := INF
	var smax := -INF

	var q := _query
	if q == null:
		q = PhysicsRayQueryParameters3D.new()
		_query = q
	q.exclude = [body.get_rid()]

	for i in SAMPLES_ALONG:
		var fx := -half.x + footprint.x * (float(i) / float(SAMPLES_ALONG - 1))
		var world_pt := xform * Vector3(fx, -half.y, 0.0)
		q.from = world_pt + up * RAY_UP
		q.to = world_pt - up * RAY_DOWN
		var hit := space.intersect_ray(q)
		if hit.is_empty():
			continue
		var col := hit.get("collider") as StaticBody3D
		if col != null and col.is_in_group(SURFACE_GROUP):
			flow_sum += col.constant_linear_velocity
			hits += 1
			if debug:
				var s := Vector2(col.constant_linear_velocity.x, col.constant_linear_velocity.z).length()
				smin = minf(smin, s)
				smax = maxf(smax, s)

	if hits == 0:
		return

	var target := flow_sum / float(hits)
	var cur := body.linear_velocity
	var accel := Vector3(target.x - cur.x, 0.0, target.z - cur.z) / delta
	if accel.length() > DRIVE_MAX_ACCEL:
		accel = accel.normalized() * DRIVE_MAX_ACCEL
	body.apply_central_force(accel * body.mass)

	if debug:
		_trace(body, hits, smin, smax, target, cur, accel)


static func _trace(body: RigidBody3D, hits: int, smin: float, smax: float,
		target: Vector3, cur: Vector3, accel: Vector3) -> void:
	var now := Time.get_ticks_msec()
	var id := body.get_instance_id()
	if now < int(_next_log.get(id, 0)):
		return
	_next_log[id] = now + debug_interval_ms

	var parent := body.get_parent()
	var who: String = str(parent.name) if parent != null else str(body.name)
	var tgt_spd := Vector2(target.x, target.z).length()
	var cur_spd := Vector2(cur.x, cur.z).length()
	var straddling: bool = (smax - smin) > 0.05
	var tag := "  <-- SEAM, blending" if straddling else ""
	print("[ConvDrive] %s  on %d/%d samples  belt %.2f-%.2f m/s  target %.2f  box %.2f  closing %+.2f  push %.0f%%%s" % [
			who, hits, SAMPLES_ALONG, smin, smax, tgt_spd, cur_spd,
			tgt_spd - cur_spd, 100.0 * accel.length() / DRIVE_MAX_ACCEL, tag])
