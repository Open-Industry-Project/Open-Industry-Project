@tool
class_name GenericData
extends Node

enum Datatype {
	BOOL,
	FLOAT,
	DOUBLE,
	INT
}

@export var data_type: Datatype = Datatype.BOOL:
	set(value):
		data_type = value
		match data_type:
			Datatype.FLOAT:
				tag_value = 0.0
			Datatype.DOUBLE, Datatype.INT:
				tag_value = 0
			Datatype.BOOL:
				tag_value = false


@export var tag_value: Variant:
	set(value):
		if is_same(value,tag_value):
			return
		tag_value = value
		match data_type:
			Datatype.BOOL:
				OIPComms.write_bit(tag_group_name, tag_name, value)
			Datatype.FLOAT:
				OIPComms.write_float32(tag_group_name, tag_name, value)
			Datatype.DOUBLE:
				OIPComms.write_int32(tag_group_name, tag_name, value)
			Datatype.INT:
				OIPComms.write_int32(tag_group_name, tag_name, value)

var register_tag_ok := false
var tag_group_init := false
var tag_group_original: String
var _enable_comms_changed = false:
	set(value):
		notify_property_list_changed()

@export_category("Communications")

@export var enable_comms := false
@export var tag_group_name: String
@export_custom(0,"tag_group_enum") var tag_groups:
	set(value):
		tag_group_name = value
		tag_groups = value
		
@export var tag_name := ""
@export var setup := false

func _validate_property(property: Dictionary):
	if property.name == "tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "enable_comms":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "setup":
		property.usage = PROPERTY_USAGE_STORAGE

func _property_can_revert(property: StringName) -> bool:
	return property == "tag_groups" || property == "tag_value"

func _property_get_revert(property: StringName) -> Variant:
	if property == "tag_groups":
		return tag_group_original
	elif property == "tag_value":
		return tag_value
	else:
		return

func _enter_tree() -> void:
	if not setup:
		tag_value = false
		setup = true
	
	tag_group_original = tag_group_name
	if(tag_group_name.is_empty()):
		tag_group_name = OIPComms.get_tag_groups()[0]

	tag_groups = tag_group_name
	
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)
	OIPComms.tag_group_polled.connect(_tag_group_polled)
	OIPComms.enable_comms_changed.connect(func() -> void: _enable_comms_changed = OIPComms.get_enable_comms)

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)

func _on_simulation_started() -> void:
	if enable_comms:
		register_tag_ok = OIPComms.register_tag(tag_group_name, tag_name, 1)

func _tag_group_initialized(_tag_group_name: String) -> void:
	if _tag_group_name == tag_group_name:
		tag_group_init = true
			
func _tag_group_polled(_tag_group_name: String) -> void:
	if not enable_comms: return
	var converted: Variant
	match data_type:
		Datatype.BOOL:
			converted = OIPComms.read_bit(tag_group_name, tag_name)
		Datatype.FLOAT:
			converted = OIPComms.read_float32(tag_group_name, tag_name)
		Datatype.DOUBLE:
			converted = OIPComms.read_int32(tag_group_name, tag_name)
		Datatype.INT:
			converted = OIPComms.read_int32(tag_group_name, tag_name)
	tag_value = converted
