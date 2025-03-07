@tool
extends Node3D

@export var segment_data: StackSegmentData:
	set(value):
		if segment_data:
			segment_data.active_changed.disconnect(_on_active_changed)
			segment_data.color_changed.disconnect(_on_color_changed)
		
		segment_data = value as StackSegmentData
		
		if material != null and segment_data != null:
			_set_active(segment_data.active)
			_set_segment_color(segment_data.segment_color)
		
		segment_data.active_changed.connect(_on_active_changed)
		segment_data.color_changed.connect(_on_color_changed)
		
var mesh_instance: MeshInstance3D
var material: StandardMaterial3D

func _ready() -> void:
	mesh_instance = $LightMesh
	mesh_instance.mesh = mesh_instance.mesh.duplicate()
	
	material = mesh_instance.mesh.surface_get_material(0).duplicate() as StandardMaterial3D
	mesh_instance.mesh.surface_set_material(0, material)
	
	if segment_data:
		segment_data.active_changed.disconnect(_on_active_changed)
		segment_data.color_changed.disconnect(_on_color_changed)
		
		_set_active(segment_data.active)
		_set_segment_color(segment_data.segment_color)
		
		segment_data.active_changed.connect(_on_active_changed)
		segment_data.color_changed.connect(_on_color_changed)

func _set_active(new_value: bool) -> void:
	if material == null:
		return
	if new_value:
		material.emission_energy_multiplier = 1.0
	else:
		material.emission_energy_multiplier = 0.0

func _set_segment_color(new_value: Color) -> void:
	if material:
		material.albedo_color = new_value
		material.emission = new_value

func _on_active_changed(new_active: bool) -> void:
	_set_active(new_active)

func _on_color_changed(new_color: Color) -> void:
	_set_segment_color(new_color)
