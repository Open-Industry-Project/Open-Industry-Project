@tool
class_name LegBars
extends Node3D

@export var bar_mesh: Mesh
@export var bar_material: Material

@export var parent_scale: Vector3 = Vector3.ONE:
	set(value):
		parent_scale = value
		_update()

var bars_distance: float = 1.0
var prev_scale: Vector3

var _mm_instance: MultiMeshInstance3D
var _multi_mesh: MultiMesh


func _ready() -> void:
	set_notify_transform(true)
	_ensure_multimesh()
	_update()


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		if owner and parent_scale != prev_scale:
			_update()


func _ensure_multimesh() -> void:
	if _mm_instance:
		return

	# Remove any legacy individual bar children
	for child in get_children():
		child.queue_free()

	_multi_mesh = MultiMesh.new()
	_multi_mesh.transform_format = MultiMesh.TRANSFORM_3D

	_mm_instance = MultiMeshInstance3D.new()
	_mm_instance.multimesh = _multi_mesh
	add_child(_mm_instance)

	if bar_mesh:
		_multi_mesh.mesh = bar_mesh
	if bar_material:
		_mm_instance.material_override = bar_material


func _update() -> void:
	if not is_node_ready():
		return
	_ensure_multimesh()

	var bar_count: int = maxi(floori(parent_scale.y), 1)
	_multi_mesh.instance_count = bar_count

	for i in bar_count:
		var y_pos: float = bars_distance * (i + 1)
		_multi_mesh.set_instance_transform(i, Transform3D(Basis.IDENTITY, Vector3(0, y_pos, 0)))

	var inv_scale := Vector3(1.0 / parent_scale.x, 1.0 / parent_scale.y, 1.0)
	if scale != inv_scale:
		scale = inv_scale
	prev_scale = parent_scale
