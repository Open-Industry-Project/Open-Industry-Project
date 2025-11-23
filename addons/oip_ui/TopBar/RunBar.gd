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

	play_button.shortcut = null
	pause_button.shortcut = null
	stop_button.shortcut = null

	_update_tooltips()

	var editor_settings := EditorInterface.get_editor_settings()
	var start_shortcut := editor_settings.get_shortcut("Open Industry Project/Start Simulation")
	var pause_shortcut := editor_settings.get_shortcut("Open Industry Project/Toggle Pause Simulation")
	var stop_shortcut := editor_settings.get_shortcut("Open Industry Project/Stop Simulation")

	start_shortcut.changed.connect(_update_tooltips)
	pause_shortcut.changed.connect(_update_tooltips)
	stop_shortcut.changed.connect(_update_tooltips)

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


func _update_tooltips() -> void:
	var editor_settings := EditorInterface.get_editor_settings()
	var start_shortcut := editor_settings.get_shortcut("Open Industry Project/Start Simulation")
	var pause_shortcut := editor_settings.get_shortcut("Open Industry Project/Toggle Pause Simulation")
	var stop_shortcut := editor_settings.get_shortcut("Open Industry Project/Stop Simulation")

	play_button.shortcut = start_shortcut
	play_button.shortcut_in_tooltip = false
	play_button.tooltip_text = "Start Simulation (%s)" % start_shortcut.get_as_text()

	pause_button.shortcut = pause_shortcut
	pause_button.shortcut_in_tooltip = false
	pause_button.tooltip_text = "Pause Simulation (%s)" % pause_shortcut.get_as_text()

	stop_button.shortcut = stop_shortcut
	stop_button.shortcut_in_tooltip = false
	stop_button.tooltip_text = "Stop Simulation (%s)" % stop_shortcut.get_as_text()
