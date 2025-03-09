@tool
extends Node3D
class_name ChainTransfer

const BASE_LENGTH: float = 2.0

@onready var chain_transfer_bases: ChainTransferBases = $ChainBases

var chain_transfer_base_scene: PackedScene = load("res://src/ChainTransfer/Base.tscn")

@export var chains: int = 2:
	set(value):
		var new_value: int = clamp(value, 2, 6)
		if new_value > chains:
			_spawn_chains(new_value - chains)
		else:
			_remove_chains(chains - new_value)
		chains = new_value
		_fix_chains(chains)
		_update_simple_shape()

@export_range(0.25,1.0,0.01,"or_greater suffix: m") var distance: float = 0.33:
	set(value):
		distance = clamp(value, 0.03, 5.0)
		_set_chains_distance(distance)

var speed: float = 2.0
@export_custom(PROPERTY_HINT_NONE,"suffix: m/s") var Speed: float = 2.0

@export var popup_chains: bool = false

var prev_scale: Vector3

func _init() -> void:
	set_notify_local_transform(true)

func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		if scale != prev_scale:
			_rescale()

func _ready() -> void:
	_spawn_chains(chains - get_child_count())
	_set_chains_distance(distance)
	_set_chain_speed(speed)
	_set_popup_chains(popup_chains)
	_rescale()

func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)

func use() -> void:
	popup_chains = !popup_chains

func _physics_process(delta: float) -> void:
	_set_popup_chains(popup_chains)
	if SimulationEvents.simulation_running:
		_set_chain_speed(speed)

# _rescale resets scale to (scale.x, 1, 1) and updates the simple shape.
func _rescale() -> void:
	prev_scale = Vector3(scale.x, 1, 1)
	scale = prev_scale
	_update_simple_shape()

func _set_chains_distance(dist: float) -> void:
	chain_transfer_bases.set_chains_distance(dist)

func _set_chain_speed(speed: float) -> void:
	chain_transfer_bases.set_chains_speed(speed)

func _set_popup_chains(popup: bool) -> void:
	chain_transfer_bases.set_chains_popup_chains(popup)

func _turn_on_chains() -> void:
	chain_transfer_bases.turn_on_chains()

func _turn_off_chains() -> void:
	chain_transfer_bases.turn_off_chains()

func _spawn_chains(count: int) -> void:
	if chains <= 0:
		return
	for i in range(count):
		var chain_base = chain_transfer_base_scene.instantiate() as ChainTransferBase
		chain_transfer_bases.add_child(chain_base, true)
		chain_base.owner = self
		chain_base.position = Vector3(0, 0, distance * chain_base.get_index())
		chain_base.active = popup_chains
		chain_base.speed = speed
		if SimulationEvents.simulation_running:
			chain_base.turn_on()

func _remove_chains(count: int) -> void:
	chain_transfer_bases.remove_chains(count)

func _fix_chains(ch: int) -> void:
	chain_transfer_bases.fix_chains(ch)

func _on_simulation_started() -> void:
	_turn_on_chains()

func _on_simulation_ended() -> void:
	_turn_off_chains()

func _update_simple_shape() -> void:
	var simple_conveyor_shape_body = get_node("SimpleConveyorShape") as Node3D
	simple_conveyor_shape_body.scale = scale.inverse()
	var simple_conveyor_shape_node = simple_conveyor_shape_body.get_node("CollisionShape3D") as CollisionShape3D
	simple_conveyor_shape_node.position = Vector3(0, -0.094, (chains - 1) * distance / 2.0)
	var simple_conveyor_shape = simple_conveyor_shape_node.shape as BoxShape3D
	simple_conveyor_shape.size = Vector3(scale.x * BASE_LENGTH + 0.25, 0.2, (chains - 1) * distance + 0.042 * 2.0)
