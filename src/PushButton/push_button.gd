@tool
extends Node3D
class_name PushButton

@export var text: String = "Stop":
	set(value):
		text = value
		if _text_mesh:
			_text_mesh.text = text

@export var toggle: bool = false:
	set(value):
		toggle = value
		if not toggle:
			pushbutton = false


@export var pushbutton: bool = false:
	set(value):
		pushbutton = value
		if not toggle and pushbutton:
			reset_pushbutton()
			var tween = create_tween()
			tween.tween_property(_button_mesh, "position", Vector3(0, 0, _button_pressed_z_pos), 0.035)
			tween.tween_interval(0.2)
			tween.tween_property(_button_mesh, "position", Vector3.ZERO, 0.02)
		elif _button_mesh:
			if pushbutton:
				_button_mesh.position = Vector3(0, 0, _button_pressed_z_pos)
			else:
				_button_mesh.position = Vector3.ZERO
		

@export var lamp: bool = false:
	set(value):
		lamp = value
		if not  _button_material:
			return
		if value:
			_button_material.emission_energy_multiplier = 1.0
		else:
			_button_material.emission_energy_multiplier = 0.0

@export var button_color: Color = Color.RED:
	set(value):
		button_color = value
		if _button_material:
			_button_material.albedo_color = value
			_button_material.emission = value
	
var _text_mesh_instance: MeshInstance3D
var _text_mesh: TextMesh

var _button_mesh: MeshInstance3D
var _button_material: StandardMaterial3D
var _button_pressed_z_pos: float = -0.04

func reset_pushbutton() -> void:
	await get_tree().create_timer(0.3).timeout
	pushbutton = false

func _ready() -> void:
	_text_mesh_instance = $TextMesh
	_text_mesh = _text_mesh_instance.mesh.duplicate() as TextMesh
	_text_mesh_instance.mesh = _text_mesh
	_text_mesh.text = text

	_button_mesh = $Meshes/Button
	_button_mesh.mesh = _button_mesh.mesh.duplicate()
	_button_material = _button_mesh.mesh.surface_get_material(0).duplicate() as StandardMaterial3D
	_button_mesh.mesh.surface_set_material(0, _button_material)

func use() -> void:
	pushbutton = not pushbutton
