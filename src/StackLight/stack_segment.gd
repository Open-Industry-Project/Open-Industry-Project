@tool
class_name StackSegment
extends Node3D

signal active_state_changed(index: int, active: bool)

@export var segment_data: StackSegmentData:
	set(value):
		if segment_data:
			segment_data.active_changed.disconnect(_on_active_changed)
			segment_data.color_changed.disconnect(_on_color_changed)

		segment_data = value as StackSegmentData

		if _material != null and segment_data != null:
			_set_active(segment_data.active)
			_set_segment_color(segment_data.segment_color)

		segment_data.active_changed.connect(_on_active_changed)
		segment_data.color_changed.connect(_on_color_changed)

var _mesh_instance: MeshInstance3D
var _material: StandardMaterial3D
var index: int = -1

func _ready() -> void:
	_mesh_instance = $LightMesh
	_mesh_instance.mesh = _mesh_instance.mesh.duplicate()

	_material = _mesh_instance.mesh.surface_get_material(0).duplicate() as StandardMaterial3D
	_mesh_instance.mesh.surface_set_material(0, _material)

	if segment_data:
		segment_data.active_changed.disconnect(_on_active_changed)
		segment_data.color_changed.disconnect(_on_color_changed)

		_set_active(segment_data.active)
		_set_segment_color(segment_data.segment_color)

		segment_data.active_changed.connect(_on_active_changed)
		segment_data.color_changed.connect(_on_color_changed)

func _set_active(new_value: bool) -> void:
	if _material == null:
		return
	
	if new_value:
		_material.emission_energy_multiplier = 1.0
	else:
		_material.emission_energy_multiplier = 0.0

func _set_segment_color(new_value: Color) -> void:
	if _material:
		_material.albedo_color = new_value
		_material.emission = new_value

func _on_active_changed(new_active: bool) -> void:
	_set_active(new_active)
	active_state_changed.emit(index, new_active)

func _on_color_changed(new_color: Color) -> void:
	_set_segment_color(new_color)
