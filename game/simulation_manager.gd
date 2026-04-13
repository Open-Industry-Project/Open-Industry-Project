## Autoload singleton that provides simulation state management.
##
## In the Godot editor, it proxies signals from the custom EditorInterface.
## In a standalone game, it manages simulation state directly and starts the
## simulation automatically once the scene tree is ready.
extends Node

signal simulation_started
signal simulation_stopped
signal simulation_pause_toggled(paused: bool)

var _running: bool = false
var _paused: bool = false


func _ready() -> void:
	if Engine.is_editor_hint():
		# Proxy the custom EditorInterface simulation signals so that
		# equipment scripts only need to reference SimulationManager.
		EditorInterface.simulation_started.connect(func() -> void: simulation_started.emit())
		EditorInterface.simulation_stopped.connect(func() -> void: simulation_stopped.emit())
		EditorInterface.simulation_pause_toggled.connect(
			func(p: bool) -> void: simulation_pause_toggled.emit(p)
		)
	else:
		# In the standalone game the simulation should begin once every
		# equipment node has finished _enter_tree / _ready, so we defer
		# the start signal by one frame.
		call_deferred("_start_game_simulation")


func _start_game_simulation() -> void:
	_running = true
	simulation_started.emit()


func is_simulation_running() -> bool:
	if Engine.is_editor_hint():
		return EditorInterface.is_simulation_running()
	return _running


func is_simulation_paused() -> bool:
	if Engine.is_editor_hint():
		return EditorInterface.is_simulation_paused()
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
