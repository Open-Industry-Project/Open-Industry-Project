@tool
extends Node3D
class_name PushButton

@export var text: String = "STOP":
	set(value):
		text = value
		var _text: Label3D = $Text
		_text.text = text
		

@export var toggle: bool = false:
	set(value):
		toggle = value
		if not toggle:
			pushbutton = false


@export var pushbutton: bool = false:
	set(value):
		if register_pushbutton_tag_ok and value != pushbutton:
			OIPComms.write_bit(pushbutton_tag_group_name, pushbutton_tag_name, value)
		
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

var _button_mesh: MeshInstance3D:
	get:
		return $Meshes/Button
var _button_material: StandardMaterial3D:
	get:
		return _button_mesh.mesh.surface_get_material(0)
var _button_pressed_z_pos: float = -0.04

var register_pushbutton_tag_ok := false
var register_lamp_tag_ok := false
var pushbutton_tag_group_init := false
var pushbutton_tag_group_original: String
var lamp_tag_group_init := false
var lamp_tag_group_original: String
var _enable_comms_changed = false:
	set(value):
		notify_property_list_changed()

@export_category("Communications")
@export var enable_comms := false
@export var pushbutton_tag_group_name: String
@export_custom(0,"tag_group_enum") var pushbutton_tag_groups:
	set(value):
		pushbutton_tag_group_name = value
		pushbutton_tag_groups = value
@export var pushbutton_tag_name := ""
@export var lamp_tag_group_name: String
@export_custom(0,"tag_group_enum") var lamp_tag_groups:
	set(value):
		lamp_tag_group_name = value
		lamp_tag_groups = value
@export var lamp_tag_name := ""

func _validate_property(property: Dictionary):
	if property.name == "enable_comms":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "pushbutton_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "pushbutton_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "pushbutton_tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "lamp_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "lamp_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "lamp_tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE

func reset_pushbutton() -> void:
	await get_tree().create_timer(0.3).timeout
	pushbutton = false

func _ready() -> void:
	var mesh: Mesh = _button_mesh.mesh.duplicate()
	var mat: StandardMaterial3D = mesh.surface_get_material(0).duplicate()
	mesh.surface_set_material(0, mat)
	_button_mesh.mesh = mesh

func _property_can_revert(property: StringName) -> bool:
	return property == "pushbutton_tag_groups" || property == "lamp_tag_groups"

func _property_get_revert(property: StringName) -> Variant:
	if property == "pushbutton_tag_groups":
		return pushbutton_tag_group_original
	elif property == "lamp_tag_groups":
		return lamp_tag_group_original
	else:
		return
		
func _enter_tree() -> void:
	pushbutton_tag_group_original = pushbutton_tag_group_name
	if(pushbutton_tag_group_name.is_empty()):
		pushbutton_tag_group_name = OIPComms.get_tag_groups()[0]
		pushbutton_tag_group_original = pushbutton_tag_group_name

	pushbutton_tag_groups = pushbutton_tag_group_name
	
	lamp_tag_group_original = lamp_tag_group_name
	if(lamp_tag_group_name.is_empty()):
		lamp_tag_group_name = OIPComms.get_tag_groups()[0]
		lamp_tag_group_original = lamp_tag_group_name

	lamp_tag_groups = lamp_tag_group_name
	
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	OIPComms.tag_group_polled.connect(_tag_group_polled)
	OIPComms.enable_comms_changed.connect(func() -> void: _enable_comms_changed = OIPComms.get_enable_comms)

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)

func _on_simulation_started() -> void:
	if enable_comms:
		register_pushbutton_tag_ok = OIPComms.register_tag(pushbutton_tag_group_name, pushbutton_tag_name, 1)
		register_lamp_tag_ok = OIPComms.register_tag(lamp_tag_group_name, lamp_tag_name, 1)

func _tag_group_polled(_tag_group_name: String) -> void:
	if not enable_comms: return
	if _tag_group_name == lamp_tag_group_name:
		lamp = OIPComms.read_bit(lamp_tag_group_name, lamp_tag_name)

func use() -> void:
	pushbutton = not pushbutton
