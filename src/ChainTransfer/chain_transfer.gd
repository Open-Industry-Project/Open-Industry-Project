@tool
class_name ChainTransfer
extends Node3D

const BASE_LENGTH: float = 2.0

## Number of chain lanes (2-6).
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

## Distance between chain lanes in meters.
@export_range(0.25, 1.0, 0.01, "or_greater", "suffix:m") var distance: float = 0.33:
	set(value):
		distance = clamp(value, 0.03, 5.0)
		_set_chains_distance(distance)

## Speed of the chains in meters per second.
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var speed: float = 2.0:
	set(value):
		speed = value
		if SimulationEvents.simulation_running:
			_set_chain_speed(speed)

## When true, chains are raised to lift products off the main conveyor.
@export var popup_chains: bool = false:
	set(value):
		popup_chains = value
		_set_popup_chains(popup_chains)

@export_category("Communications")
## Enable communication with external PLC/control systems.
@export var enable_comms: bool = false
@export var speed_tag_group_name: String
## The tag group for reading speed values from external systems.
@export_custom(0, "tag_group_enum") var speed_tag_groups:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
## The tag name for the speed value in the selected tag group.[br]Datatype: [code]REAL[/code] (32-bit float)[br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]hr0[/code])[br][b]OPC UA:[/b] identifier after the namespace prefix (e.g. [code]MyVariable[/code] from [code]ns=2;s=MyVariable[/code], or [code]12345[/code] from [code]ns=2;i=12345[/code]).
@export var speed_tag_name: String = ""
@export var popup_tag_group_name: String
## The tag group for reading popup state from external systems.
@export_custom(0, "tag_group_enum") var popup_tag_groups:
	set(value):
		popup_tag_group_name = value
		popup_tag_groups = value
## The tag name for the popup state in the selected tag group.[br]Datatype: [code]BOOL[/code][br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]co0[/code])[br][b]OPC UA:[/b] identifier after the namespace prefix (e.g. [code]MyVariable[/code] from [code]ns=2;s=MyVariable[/code], or [code]12345[/code] from [code]ns=2;i=12345[/code]).
@export var popup_tag_name: String = ""

var _prev_scale: Vector3 = Vector3.ONE
var _register_speed_tag_ok: bool = false
var _register_running_tag_ok: bool = false
var _speed_tag_group_init: bool = false
var _popup_tag_group_init: bool = false
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

	if speed_tag_group_name.is_empty() and OIPComms.get_tag_groups().size() > 0:
		speed_tag_group_name = OIPComms.get_tag_groups()[0]
	if popup_tag_group_name.is_empty() and OIPComms.get_tag_groups().size() > 0:
		popup_tag_group_name = OIPComms.get_tag_groups()[0]

	OIPComms.enable_comms_changed.connect(notify_property_list_changed)

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)
	OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)

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
	_set_chain_speed(speed)

	if enable_comms:
		_register_speed_tag_ok = OIPComms.register_tag(speed_tag_group_name, speed_tag_name, 1)
		_register_running_tag_ok = OIPComms.register_tag(popup_tag_group_name, popup_tag_name, 1)

func _on_simulation_ended() -> void:
	_turn_off_chains()

func _get_custom_preview_node() -> Node3D:
	var preview_scene := load("res://parts/ChainTransfer.tscn") as PackedScene
	var preview_node = preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D

	_disable_collisions_recursive(preview_node)

	var chain_bases_node = preview_node.get_node_or_null("ChainBases")
	if chain_bases_node:
		for base in chain_bases_node.get_children():
			base.set_process_mode(Node.PROCESS_MODE_DISABLED)

	return preview_node


func _disable_collisions_recursive(node: Node) -> void:
	if node is CollisionShape3D:
		node.disabled = true

	if node is CollisionObject3D:
		node.collision_layer = 0
		node.collision_mask = 0

	for child in node.get_children():
		_disable_collisions_recursive(child)


func _update_simple_shape() -> void:
	var simple_conveyor_shape_body := get_node_or_null("SimpleConveyorShape") as Node3D
	if not simple_conveyor_shape_body:
		return
	var simple_conveyor_shape_node := simple_conveyor_shape_body.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if not simple_conveyor_shape_node:
		return
	simple_conveyor_shape_node.position = Vector3(0, -0.094, (chains - 1) * distance / 2.0)
	var simple_conveyor_shape := simple_conveyor_shape_node.shape as BoxShape3D
	if simple_conveyor_shape:
		simple_conveyor_shape.size = Vector3(BASE_LENGTH + 0.25 / scale.x, 0.2, (chains - 1) * distance + 0.042 * 2.0)

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
