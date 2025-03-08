@tool
class_name Diverter
extends Node3D

@export_tool_button("Divert") var divert_action = divert

@export var divert_time: float = 0.3
@export var divert_distance: float = 1.5

var fire_divert: bool = false
var scan_interval: float = 0.0
var cycled: bool = false
var diverting: bool = false
var previous_fire_divert_state: bool = false

var diverter_animator  # Expected to be of type DiverterAnimator
var Main  # Reference to the main (simulation) node

# Additional control variables (assumed defaults)
var enable_comms: bool = false
var read_successful: bool = false
var running: bool = false

func _ready() -> void:
	diverter_animator = $DiverterAnimator

func _enter_tree() -> void:
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)

func _exit_tree() -> void:
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)

func use() -> void:
	divert()

func divert() -> void:
	fire_divert = true
	await get_tree().create_timer(0.3).timeout
	fire_divert = false

func _physics_process(delta: float) -> void:
	if fire_divert and not previous_fire_divert_state:
		diverting = true
		cycled = false

	if divert and not cycled:
		diverter_animator.Fire(divert_time, divert_distance)
		diverting = false
		cycled = true

	previous_fire_divert_state = fire_divert

func _on_simulation_ended() -> void:
	diverter_animator.Disable()
