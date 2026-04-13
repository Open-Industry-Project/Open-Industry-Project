## Autoload singleton that provides simulation state management.
##
## Manages simulation state directly via _running and _paused flags.
## In a standalone game, the simulation starts automatically once the
## scene tree is ready.
extends Node

signal simulation_started
signal simulation_stopped
signal simulation_pause_toggled(paused: bool)

var _running: bool = false
var _paused: bool = false


func _ready() -> void:
	if not Engine.is_editor_hint():
		# In the standalone game the simulation should begin once every
		# equipment node has finished _enter_tree / _ready, so we defer
		# the start signal by one frame.
		call_deferred("_start_game_simulation")


func _start_game_simulation() -> void:
	_running = true
	simulation_started.emit()


func is_simulation_running() -> bool:
	return _running


func is_simulation_paused() -> bool:
	return _paused


func start_simulation() -> void:
	if not _running:
		_running = true
		_paused = false
		simulation_started.emit()


func stop_simulation() -> void:
	if _running:
		_running = false
		simulation_stopped.emit()


func toggle_pause() -> void:
	_paused = not _paused
	simulation_pause_toggled.emit(_paused)


func set_paused(paused: bool) -> void:
	if _paused != paused:
		_paused = paused
		simulation_pause_toggled.emit(_paused)
