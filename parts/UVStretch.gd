@tool
extends MeshInstance3D

@export_group("UV Tiling")
@export_range(0.01, 100.0, 0.01) var u_tiling_multiplier: float = 1.0:
	set(value):
		u_tiling_multiplier = value
		_rebuild_from_source()

@export var auto_apply_in_editor: bool = true

@export_group("Material Mask")
@export var tiling_material_name_contains: String = "Trim"
@export var non_tiling_material_name_contains: String = "Standard"

@export_group("Source Backup")
@export var source_mesh: Mesh

@export_tool_button("Recapture Current Mesh as Default")
var capture_default_action: Callable = _capture_current_as_default

@export_tool_button("Reset to Default")
var reset_default_action: Callable = _reset_to_default

var _original_uvs_per_surface: Array[PackedVector2Array] = []
var _initializing: bool = false

func _ready() -> void:
	if not Engine.is_editor_hint():
		return

	_initializing = true
	_ensure_source_mesh()
	_cache_original_uvs()
	if auto_apply_in_editor:
		_rebuild_from_source()
	_initializing = false

func _notification(what: int) -> void:
	if not Engine.is_editor_hint():
		return

	if what == NOTIFICATION_ENTER_TREE:
		_ensure_source_mesh()
		_cache_original_uvs()

func _ensure_source_mesh() -> void:
	if source_mesh == null and mesh != null:
		source_mesh = mesh

func _capture_current_as_default() -> void:
	if mesh == null:
		push_warning("BeamMain UV Tool: No mesh to capture.")
		return

	source_mesh = mesh
	_cache_original_uvs()
	u_tiling_multiplier = 1.0
	_rebuild_from_source()

func _reset_to_default() -> void:
	_ensure_source_mesh()
	if source_mesh == null:
		push_warning("BeamMain UV Tool: No source mesh available.")
		return

	mesh = source_mesh
	_cache_original_uvs()
	u_tiling_multiplier = 1.0

func _cache_original_uvs() -> void:
	_original_uvs_per_surface.clear()

	if source_mesh == null:
		return

	for surface_idx in range(source_mesh.get_surface_count()):
		var arrays := source_mesh.surface_get_arrays(surface_idx)
		if arrays.is_empty():
			_original_uvs_per_surface.append(PackedVector2Array())
			continue

		var uvs: PackedVector2Array = arrays[Mesh.ARRAY_TEX_UV]
		_original_uvs_per_surface.append(uvs.duplicate())

func _rebuild_from_source() -> void:
	if _initializing:
		return

	_ensure_source_mesh()
	if source_mesh == null:
		return
	if source_mesh.get_surface_count() == 0:
		return
	if _original_uvs_per_surface.size() != source_mesh.get_surface_count():
		_cache_original_uvs()

	var new_mesh := ArrayMesh.new()

	for surface_idx in range(source_mesh.get_surface_count()):
		var arrays := source_mesh.surface_get_arrays(surface_idx)
		if arrays.is_empty():
			continue

		var original_uvs: PackedVector2Array = _original_uvs_per_surface[surface_idx]
		var new_uvs := PackedVector2Array()
		new_uvs.resize(original_uvs.size())

		var mat: Material = source_mesh.surface_get_material(surface_idx)
		var mat_name := ""
		if mat:
			mat_name = mat.resource_name

		var should_scale_uv := false
		if mat_name.contains(tiling_material_name_contains):
			should_scale_uv = true

		for i in range(original_uvs.size()):
			var uv: Vector2 = original_uvs[i]
			if should_scale_uv:
				new_uvs[i] = Vector2(uv.x * u_tiling_multiplier, uv.y)
			else:
				new_uvs[i] = uv

		arrays[Mesh.ARRAY_TEX_UV] = new_uvs
		new_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)

		if mat:
			new_mesh.surface_set_material(surface_idx, mat)

	mesh = new_mesh
