@tool
class_name Diverter
extends Node3D

@export_tool_button("Divert") var divert_action = divert

@export var divert_time: float = 0.3
@export var divert_distance: float = 1.5

var _fire_divert: bool = false
var _cycled: bool = true
var _diverting: bool = false
var _previous_fire_divert_state: bool = false
var _diverter_animator

func _ready() -> void:
	_diverter_animator = $DiverterAnimator

func use() -> void:
	divert()

func divert() -> void:
	_fire_divert = true
	await get_tree().create_timer(0.3).timeout
	_fire_divert = false

func _physics_process(delta: float) -> void:
	if _fire_divert and not _previous_fire_divert_state:
		_diverting = true
		_cycled = false

	if divert and not _cycled:
		_diverter_animator.Fire(divert_time, divert_distance)
		_diverting = false
		_cycled = true

	_previous_fire_divert_state = _fire_divert
