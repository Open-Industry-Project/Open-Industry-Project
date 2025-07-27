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

var index: int = -1
@onready var _mesh_instance: MeshInstance3D = $LightMesh
var _material: StandardMaterial3D

func _ready() -> void:
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
		var opaque_color := Color(segment_data.segment_color.r, segment_data.segment_color.g, segment_data.segment_color.b, 235.0/255.0)
		_material.albedo_color = opaque_color
		_material.emission = Color(segment_data.segment_color.r, segment_data.segment_color.g, segment_data.segment_color.b, 1.0)
	else:
		_material.emission_energy_multiplier = 0.0
		_material.albedo_color = Color(0.7, 0.7, 0.7, 1.0)
		_material.emission = Color(0.0, 0.0, 0.0, 1.0)

func _set_segment_color(new_value: Color) -> void:
	if _material and segment_data and segment_data.active:
		var albedo_color := Color(new_value.r, new_value.g, new_value.b, 235.0/255.0)
		var emission_color := Color(new_value.r, new_value.g, new_value.b, 1.0)
		_material.albedo_color = albedo_color
		_material.emission = emission_color

func _on_active_changed(new_active: bool) -> void:
	_set_active(new_active)
	active_state_changed.emit(index, new_active)

func _on_color_changed(new_color: Color) -> void:
	_set_segment_color(new_color)
