@tool
class_name RunBar
extends PanelContainer

var play: bool = false
var pause: bool = true
var stop: bool = true
var clear_output_btn: Button

@onready var play_button: Button = $HBoxContainer/Play
@onready var pause_button: Button = $HBoxContainer/Pause
@onready var stop_button: Button = $HBoxContainer/Stop


func _ready() -> void:
	if not ProjectSettings.get_setting("addons/Open Industry Project/Output/Clear on Simulation Start"):
		ProjectSettings.set_setting("addons/Open Industry Project/Output/Clear on Simulation Start", false)

	ProjectSettings.set_as_basic("addons/Open Industry Project/Output/Clear on Simulation Start", true)

	play_button.icon = get_theme_icon("Play", "EditorIcons")
	pause_button.icon = get_theme_icon("Pause", "EditorIcons")
	stop_button.icon = get_theme_icon("Stop", "EditorIcons")

	clear_output_btn =  get_tree().root.get_child(0).find_child("ClearOutputButton",true,false)

	SimulationEvents.simulation_started.connect(func() -> void:
		SimulationEvents.simulation_running = true
		PhysicsServer3D.set_active(true)
		play_button.disabled = true
		pause_button.disabled = false
		stop_button.disabled = false
		play = true
		pause = false
		stop = false

		if ProjectSettings.get_setting("addons/Open Industry Project/Output/Clear on Simulation Start"):
			clear_output_btn.pressed.emit()
	)
	
	SimulationEvents.simulation_ended.connect(func() -> void:
		SimulationEvents.simulation_running = false
		PhysicsServer3D.set_active(false)
		play_button.disabled = false
		pause_button.disabled = true
		stop_button.disabled = true
		play = false
		pause = true
		stop = true
	)

	play_button.pressed.connect(_on_play_pressed)
	pause_button.toggled.connect(_on_pause_toggled)
	stop_button.pressed.connect(_on_stop_pressed)


func _disable_buttons() -> void:
	PhysicsServer3D.set_active(false)
	play_button.disabled = true
	pause_button.disabled = true
	stop_button.disabled = true


func _enable_buttons() -> void:
	PhysicsServer3D.set_active(play)
	play_button.disabled = play
	pause_button.disabled = pause
	stop_button.disabled = stop


func _on_play_pressed() -> void:
	pause_button.button_pressed = false
	play = false
	SimulationEvents.start_simulation()


func _on_pause_toggled(pressed: bool) -> void:
	SimulationEvents.toggle_pause_simulation(pressed)


func _on_stop_pressed() -> void:
	pause_button.button_pressed = false
	pause = false
	SimulationEvents.stop_simulation()
