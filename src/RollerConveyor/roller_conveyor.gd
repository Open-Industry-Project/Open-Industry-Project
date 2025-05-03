@tool
class_name RollerConveyor
extends ResizableNode3D

@export_custom(PROPERTY_HINT_NONE, "suffix:m/s")
var speed: float = 2.0:
	set(value):
		speed = value
		if _instance_ready:
			if $RollerConveyorLegacy.speed == value:
				return
			$RollerConveyorLegacy.speed = value

			# dont write until the group is initialized
			if _register_speed_tag_ok and _speed_tag_group_init:
				OIPComms.write_float32(speed_tag_group_name, speed_tag_name, value)

			if _register_running_tag_ok and _running_tag_group_init:
				OIPComms.write_bit(running_tag_group_name, running_tag_name, value > 0.0)

@export_range(-60, 60, 1, "degrees") var skew_angle: float = 0.0:
	set(value):
		skew_angle = value
		if _instance_ready:
			$RollerConveyorLegacy.skew_angle = value

@export_category("Communications")
@export var enable_comms := false
@export var speed_tag_group_name: String
@export_custom(0, "tag_group_enum") var speed_tag_groups:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
@export var speed_tag_name := ""
@export var running_tag_group_name: String
@export_custom(0, "tag_group_enum") var running_tag_groups:
	set(value):
		running_tag_group_name = value
		running_tag_groups = value
@export var running_tag_name := ""

var _register_speed_tag_ok: bool = false
var _register_running_tag_ok: bool = false
var _speed_tag_group_init: bool = false
var _running_tag_group_init: bool = false

static func _get_constrained_size(new_size: Vector3) -> Vector3:
	return Vector3(max(1.5, new_size.x), 0.24, max(0.10, new_size.z))

func _enter_tree() -> void:
	super._enter_tree()
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)
	OIPComms.tag_group_polled.connect(_tag_group_polled)
	OIPComms.enable_comms_changed.connect(notify_property_list_changed)

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)
	OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)
	super._exit_tree()

func _on_instantiated() -> void:
	$RollerConveyorLegacy.on_scene_instantiated()
	super._on_instantiated()
	$RollerConveyorLegacy.speed = speed
	$RollerConveyorLegacy.skew_angle = skew_angle
	_instance_ready = true

	# dont write until the group is initialized
	if _register_speed_tag_ok and _speed_tag_group_init:
		OIPComms.write_float32(speed_tag_group_name, speed_tag_name, speed)

	if _register_running_tag_ok and _running_tag_group_init:
		OIPComms.write_bit(running_tag_group_name, running_tag_name, speed > 0.0)


func _on_simulation_started() -> void:
	if enable_comms:
		_register_speed_tag_ok = OIPComms.register_tag(speed_tag_group_name, speed_tag_name, 1)
		_register_running_tag_ok = OIPComms.register_tag(running_tag_group_name, running_tag_name, 1)


func _get_initial_size() -> Vector3:
	return Vector3(abs($RollerConveyorLegacy.scale.x) + 0.5, 0.24, abs($RollerConveyorLegacy.scale.z))


func _get_default_size() -> Vector3:
	return Vector3(1.525, 0.24, 1.524)


func _on_size_changed() -> void:
	$RollerConveyorLegacy.set_size(size)


func _validate_property(property: Dictionary) -> void:
	if property.name == "enable_comms":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "speed_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "speed_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "speed_tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "running_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "running_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "running_tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE


func _tag_group_initialized(tag_group_name_param: String) -> void:
	if tag_group_name_param == speed_tag_group_name:
		_speed_tag_group_init = true
	if tag_group_name_param == running_tag_group_name:
		_running_tag_group_init = true


func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms:
		return

	if tag_group_name_param == speed_tag_group_name and _speed_tag_group_init:
		speed = OIPComms.read_float32(speed_tag_group_name, speed_tag_name)
