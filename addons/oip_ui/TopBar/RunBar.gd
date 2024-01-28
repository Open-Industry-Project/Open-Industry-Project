@tool
extends PanelContainer

@onready var play_button: Button = $HBoxContainer/Play
@onready var pause_button: Button = $HBoxContainer/Pause
@onready var stop_button: Button = $HBoxContainer/Stop

var play = false
var pause = true
var stop = true

func _disable_buttons() -> void:
	play_button.disabled = true
	pause_button.disabled = true
	stop_button.disabled = true
	
func _enable_buttons() -> void:
	play_button.disabled = play
	pause_button.disabled = pause
	stop_button.disabled = stop

func _ready() -> void:
	get_tree().paused = false
	
	SimulationEvents.simulation_started.connect(func () -> void:
		play_button.disabled = true
		pause_button.disabled = false
		stop_button.disabled = false
		play = true
		pause = false
		stop = false
	)
	SimulationEvents.simulation_ended.connect(func () -> void:
		play_button.disabled = false
		pause_button.disabled = true
		stop_button.disabled = true
		play = false
		pause = true
		stop = true	
	)
	
	play_button.pressed.connect(func () -> void:
		pause_button.button_pressed = false
		play = false
		SimulationEvents.simulation_set_paused.emit(false)
		SimulationEvents.simulation_started.emit()
	)
	pause_button.toggled.connect(func (pressed: bool) -> void:
		SimulationEvents.simulation_set_paused.emit(pressed)
	)
	stop_button.pressed.connect(func () -> void:
		pause_button.button_pressed = false
		pause = false
		SimulationEvents.simulation_set_paused.emit(false)
		SimulationEvents.simulation_ended.emit()
	)
