@tool
extends Node3D
class_name PushButton

@export var text: String = "Stop":
	set(value):
		text = value
		if text_mesh:
			text_mesh.text = text

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
			var tween = get_tree().create_tween().bind_node(self)
			tween.tween_property(button_mesh, "position", Vector3(0, 0, button_pressed_z_pos), 0.035)
			tween.tween_interval(0.2)
			tween.tween_property(button_mesh, "position", Vector3.ZERO, 0.02)
		elif button_mesh:
			if pushbutton:
				button_mesh.position = Vector3(0, 0, button_pressed_z_pos)
			else:
				button_mesh.position = Vector3.ZERO
		

@export var lamp: bool = false:
	set(value):
		lamp = value
		SetActive(lamp)

@export var button_color: Color = Color.RED:
	set(value):
		button_color = value
		SetButtonColor(value)
	
var text_mesh_instance: MeshInstance3D
var text_mesh: TextMesh

var button_mesh: MeshInstance3D
var button_material: StandardMaterial3D
var button_pressed_z_pos: float = -0.04

# Asynchronous function to reset pushbutton after a delay.
func reset_pushbutton() -> void:
	await get_tree().create_timer(0.3).timeout
	pushbutton = false

func _ready() -> void:
	# Assign 3D text.
	text_mesh_instance = $TextMesh
	text_mesh = text_mesh_instance.mesh.duplicate() as TextMesh
	text_mesh_instance.mesh = text_mesh
	text_mesh.text = text

	# Assign button.
	button_mesh = $Meshes/Button
	button_mesh.mesh = button_mesh.mesh.duplicate()
	button_material = button_mesh.mesh.surface_get_material(0).duplicate() as StandardMaterial3D
	button_mesh.mesh.surface_set_material(0, button_material)

	# Initialize property states.
	SetButtonColor(button_color)
	SetActive(lamp)

func use() -> void:
	pushbutton = not pushbutton

func SetActive(new_value: bool) -> void:
	if button_material == null:
		return
	if new_value:
		button_material.emission_energy_multiplier = 1.0
	else:
		button_material.emission_energy_multiplier = 0.0

func SetButtonColor(new_value: Color) -> void:
	if button_material:
		button_material.albedo_color = new_value
		button_material.emission = new_value
