@tool
class_name Diverter
extends Node3D

var register_tag_ok := false
var tag_group_init := false
var tag_group_original: String

@export_tool_button("Divert") var divert_action = divert

@export var divert_time: float = 0.25
@export var divert_distance: float = 0.75

@export_category("Communications")

@export var enable_comms := false
@export var tag_group_name: String
@export_custom(0,"tag_group_enum") var tag_groups:
	set(value):
		tag_group_name = value
		tag_groups = value
		
@export var tag_name := ""

func _validate_property(property: Dictionary):
	if property.name == "tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE

func _property_can_revert(property: StringName) -> bool:
	return property == "tag_groups"

func _property_get_revert(property: StringName) -> Variant:
	if property == "tag_groups":
		return tag_group_original
	else:
		return

var _fire_divert: bool = false:
	set(value):
		_fire_divert = value
		await get_tree().create_timer(0.3).timeout
		_fire_divert = false
		
var _cycled: bool = true
var _diverting: bool = false
var _previous_fire_divert_state: bool = false
var _diverter_animator

func _enter_tree() -> void:
	tag_group_original = tag_group_name
	if(tag_group_name.is_empty()):
		tag_group_name = OIPComms.get_tag_groups()[0]

	tag_groups = tag_group_name
	
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)
	OIPComms.tag_group_polled.connect(_tag_group_polled)

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)
	
func _ready() -> void:
	_diverter_animator = $DiverterAnimator

func use() -> void:
	divert()

func divert() -> void:
	_fire_divert = true

func _physics_process(delta: float) -> void:
	if _fire_divert and not _previous_fire_divert_state:
		_diverting = true
		_cycled = false

	if divert and not _cycled:
		_diverter_animator.Fire(divert_time, divert_distance)
		_diverting = false
		_cycled = true

	_previous_fire_divert_state = _fire_divert
	
func _on_simulation_started() -> void:
	if enable_comms:
		register_tag_ok = OIPComms.register_tag(tag_group_name, tag_name, 1)

func _tag_group_initialized(_tag_group_name: String) -> void:
	if _tag_group_name == tag_group_name:
		tag_group_init = true
		if register_tag_ok:
			OIPComms.write_bit(tag_group_name, tag_name, _fire_divert)
			
func _tag_group_polled(_tag_group_name: String) -> void:
	if not enable_comms: return
	_fire_divert = OIPComms.read_bit(tag_group_name, tag_name)
