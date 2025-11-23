@tool
class_name ChainTransfer
extends Node3D

const BASE_LENGTH: float = 2.0

@export var chains: int = 3:
	set(value):
		var new_value: int = clamp(value, 2, 6)
		if new_value > chains:
			_spawn_chains(new_value - chains)
		else:
			_remove_chains(chains - new_value)
		chains = new_value
		_fix_chains(chains)
		_update_simple_shape()

@export_range(0.25, 1.0, 0.01, "or_greater suffix: m") var distance: float = 0.33:
	set(value):
		distance = clamp(value, 0.03, 5.0)
		_set_chains_distance(distance)

@export_custom(PROPERTY_HINT_NONE, "suffix: m/s") var speed: float = 2.0

@export var popup_chains: bool = false

@export_category("Communications")
@export var enable_comms: bool = false
@export var speed_tag_group_name: String
@export_custom(0, "tag_group_enum") var speed_tag_groups:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
@export var speed_tag_name: String = ""
@export var popup_tag_group_name: String
@export_custom(0, "tag_group_enum") var popup_tag_groups:
	set(value):
		popup_tag_group_name = value
		popup_tag_groups = value
@export var popup_tag_name: String = ""

var _prev_scale: Vector3 = Vector3.ONE
var _register_speed_tag_ok: bool = false
var _register_running_tag_ok: bool = false
var _speed_tag_group_init: bool = false
var _popup_tag_group_init: bool = false
var _speed_tag_group_original: String
var _popup_tag_group_original: String
var _chain_transfer_base_scene: PackedScene = load("res://src/ChainTransfer/Base.tscn")

@onready var chain_transfer_bases: ChainTransferBases = $ChainBases

func _init() -> void:
	set_notify_local_transform(true)

func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		if scale != _prev_scale:
			_rescale()

func _ready() -> void:
	var current_chain_count: int = chain_transfer_bases.get_child_count() if chain_transfer_bases else 0
	_spawn_chains(chains - current_chain_count)
	_set_chains_distance(distance)
	_set_chain_speed(speed)
	_set_popup_chains(popup_chains)
	_rescale()

func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)
	OIPComms.tag_group_polled.connect(_tag_group_polled)

	_speed_tag_group_original = speed_tag_group_name
	if speed_tag_group_name.is_empty():
		speed_tag_group_name = OIPComms.get_tag_groups()[0]

	speed_tag_groups = speed_tag_group_name

	_popup_tag_group_original = popup_tag_group_name
	if popup_tag_group_name.is_empty():
		popup_tag_group_name = OIPComms.get_tag_groups()[0]

	popup_tag_groups = popup_tag_group_name

	OIPComms.enable_comms_changed.connect(notify_property_list_changed)

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)
	OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)

func _physics_process(_delta: float) -> void:
	_set_popup_chains(popup_chains)
	if SimulationEvents.simulation_running:
		_set_chain_speed(speed)

func _validate_property(property: Dictionary) -> void:
	if property.name == "enable_comms":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif property.name == "speed_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "speed_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "speed_tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif property.name == "popup_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "popup_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "popup_tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE

func _property_can_revert(property: StringName) -> bool:
	return property == "speed_tag_groups" or property == "popup_tag_groups"

func _property_get_revert(property: StringName) -> Variant:
	if property == "speed_tag_groups":
		return _speed_tag_group_original
	elif property == "popup_tag_groups":
		return _popup_tag_group_original
	else:
		return null

func use() -> void:
	popup_chains = not popup_chains

func _rescale() -> void:
	_prev_scale = Vector3(scale.x, 1, 1)
	scale = _prev_scale
	_update_simple_shape()

func _set_chains_distance(dist: float) -> void:
	if chain_transfer_bases:
		chain_transfer_bases.set_chains_distance(dist)

func _set_chain_speed(speed_value: float) -> void:
	if chain_transfer_bases:
		chain_transfer_bases.set_chains_speed(speed_value)

func _set_popup_chains(popup: bool) -> void:
	if chain_transfer_bases:
		chain_transfer_bases.set_chains_popup_chains(popup)

func _turn_on_chains() -> void:
	if chain_transfer_bases:
		chain_transfer_bases.turn_on_chains()

func _turn_off_chains() -> void:
	if chain_transfer_bases:
		chain_transfer_bases.turn_off_chains()

func _spawn_chains(count: int) -> void:
	if chains <= 0:
		return
	
	if not chain_transfer_bases:
		return
		
	for i in range(count):
		var chain_base := _chain_transfer_base_scene.instantiate() as ChainTransferBase
		chain_transfer_bases.add_child(chain_base, true)
		chain_base.position = Vector3(0, 0, distance * chain_base.get_index())
		chain_base.active = popup_chains
		chain_base.speed = speed
		if SimulationEvents.simulation_running:
			chain_base.turn_on()

func _remove_chains(count: int) -> void:
	if chain_transfer_bases:
		chain_transfer_bases.remove_chains(count)

func _fix_chains(ch: int) -> void:
	if chain_transfer_bases:
		chain_transfer_bases.fix_chains(ch)

func _on_simulation_started() -> void:
	_turn_on_chains()

	if enable_comms:
		_register_speed_tag_ok = OIPComms.register_tag(speed_tag_group_name, speed_tag_name, 1)
		_register_running_tag_ok = OIPComms.register_tag(popup_tag_group_name, popup_tag_name, 1)

func _on_simulation_ended() -> void:
	_turn_off_chains()

func _update_simple_shape() -> void:
	var simple_conveyor_shape_body := get_node_or_null("SimpleConveyorShape") as Node3D
	if not simple_conveyor_shape_body:
		return
	simple_conveyor_shape_body.scale = scale.inverse()
	var simple_conveyor_shape_node := simple_conveyor_shape_body.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if not simple_conveyor_shape_node:
		return
	simple_conveyor_shape_node.position = Vector3(0, -0.094, (chains - 1) * distance / 2.0)
	var simple_conveyor_shape := simple_conveyor_shape_node.shape as BoxShape3D
	if simple_conveyor_shape:
		simple_conveyor_shape.size = Vector3(scale.x * BASE_LENGTH + 0.25, 0.2, (chains - 1) * distance + 0.042 * 2.0)

func _tag_group_initialized(tag_group_name_param: String) -> void:
	if tag_group_name_param == speed_tag_group_name:
		_speed_tag_group_init = true
	if tag_group_name_param == popup_tag_group_name:
		_popup_tag_group_init = true

func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms:
		return

	if tag_group_name_param == speed_tag_group_name and _speed_tag_group_init:
		speed = OIPComms.read_float32(speed_tag_group_name, speed_tag_name)
	if tag_group_name_param == popup_tag_group_name and _popup_tag_group_init:
		popup_chains = OIPComms.read_bit(popup_tag_groups, popup_tag_name)
