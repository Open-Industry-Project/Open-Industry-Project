class_name SensorBeamCache

const MAX_BEAMS_PER_INSTANCE := 7
const BEAM_RADIUS := 0.05

static var _beams: Dictionary = {} # instance_id -> [start, end]
static var _instances: Array = [] # Array of MeshInstance3D
# Tracks which instances each beam previously affected, so we can do targeted updates.
static var _beam_hits: Dictionary = {} # instance_id -> Array of MeshInstance3D


static func register_instance(mesh: MeshInstance3D) -> void:
	if mesh not in _instances:
		_instances.append(mesh)
		_apply_instance(mesh)


static func unregister_instance(mesh: MeshInstance3D) -> void:
	_instances.erase(mesh)
	for hits: Array in _beam_hits.values():
		hits.erase(mesh)


static func set_beam(id: int, start: Vector3, end: Vector3) -> void:
	var existing: Variant = _beams.get(id)
	if existing and existing[0] == start and existing[1] == end:
		return
	_beams[id] = [start, end]
	_refresh_beam(id)


static func clear_beam(id: int) -> void:
	if not _beams.erase(id):
		return
	# Re-apply only the instances this beam previously affected.
	var prev_hits: Array = _beam_hits.get(id, [])
	_beam_hits.erase(id)
	for mesh: MeshInstance3D in prev_hits:
		if is_instance_valid(mesh):
			_apply_instance(mesh)


static func _refresh_beam(id: int) -> void:
	var beam: Array = _beams[id]
	var prev_hits: Array = _beam_hits.get(id, [])
	var new_hits: Array = []

	# Find which instances this beam now intersects.
	var i := 0
	while i < _instances.size():
		var mesh: MeshInstance3D = _instances[i]
		if not is_instance_valid(mesh):
			_instances.remove_at(i)
			continue
		var aabb := mesh.get_aabb()
		if aabb.size != Vector3.ZERO:
			var inv := mesh.global_transform.affine_inverse()
			var expanded := aabb.grow(BEAM_RADIUS)
			if expanded.intersects_segment(inv * beam[0], inv * beam[1]):
				new_hits.append(mesh)
		i += 1

	_beam_hits[id] = new_hits

	# Re-apply instances that were or are affected by this beam.
	var dirty: Array = new_hits.duplicate()
	for mesh: MeshInstance3D in prev_hits:
		if is_instance_valid(mesh) and mesh not in dirty:
			dirty.append(mesh)
	for mesh: MeshInstance3D in dirty:
		_apply_instance(mesh)


static func _apply_instance(mesh: MeshInstance3D) -> void:
	if not is_instance_valid(mesh):
		return
	var aabb := mesh.get_aabb()
	if aabb.size == Vector3.ZERO:
		return
	var expanded := aabb.grow(BEAM_RADIUS)
	var inv := mesh.global_transform.affine_inverse()

	var count := 0
	for id: int in _beams:
		if count >= MAX_BEAMS_PER_INSTANCE:
			break
		var beam: Array = _beams[id]
		if expanded.intersects_segment(inv * beam[0], inv * beam[1]):
			mesh.set_instance_shader_parameter("beam_start_" + str(count), beam[0])
			mesh.set_instance_shader_parameter("beam_end_" + str(count), beam[1])
			count += 1
	mesh.set_instance_shader_parameter("beam_count", count)
