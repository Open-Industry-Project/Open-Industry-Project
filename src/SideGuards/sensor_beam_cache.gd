class_name SensorBeamCache

const MAX_BEAMS := 4

static var _beams: Dictionary = {} # instance_id -> [start, end]
static var _materials: Array = []


static func register_material(mat: ShaderMaterial) -> void:
	if mat not in _materials:
		_materials.append(mat)
		_apply(mat)


static func set_beam(id: int, start: Vector3, end: Vector3) -> void:
	var existing = _beams.get(id)
	if existing and existing[0] == start and existing[1] == end:
		return
	_beams[id] = [start, end]
	_refresh()


static func clear_beam(id: int) -> void:
	if _beams.erase(id):
		_refresh()


static func _refresh() -> void:
	var i := 0
	while i < _materials.size():
		if is_instance_valid(_materials[i]):
			_apply(_materials[i])
			i += 1
		else:
			_materials.remove_at(i)


static func _apply(mat: ShaderMaterial) -> void:
	var count := 0
	for beam in _beams.values():
		if count >= MAX_BEAMS:
			break
		mat.set_shader_parameter("beam_start_" + str(count), beam[0])
		mat.set_shader_parameter("beam_end_" + str(count), beam[1])
		count += 1
	mat.set_shader_parameter("beam_count", count)
