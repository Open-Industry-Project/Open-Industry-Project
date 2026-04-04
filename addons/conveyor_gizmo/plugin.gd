@tool
extends EditorPlugin

const ConveyorGizmoPlugin = preload("res://addons/conveyor_gizmo/conveyor_gizmo_plugin.gd")

const SHORTCUT_PATH = "Open Industry Project/Toggle Sideguards"
const TOOLTIP_TITLE = "Toggle Sideguards"
const TOOLTIP_BODY = "Drag: Resize a guard and create an opening.\nCtrl+Click: Split a guard into two halves.\nShift+Click: Merge with an adjacent guard, or re-anchor to the conveyor edge."

var gizmo_plugin: ConveyorGizmoPlugin
var _toggle_button: Button
var _shortcut: Shortcut

func _enter_tree():
	gizmo_plugin = ConveyorGizmoPlugin.new()
	add_node_3d_gizmo_plugin(gizmo_plugin)

	_toggle_button = CheckButton.new()
	_toggle_button.text = "Sideguards"
	_toggle_button.toggled.connect(_on_sideguard_toggle)
	add_control_to_container(CONTAINER_SPATIAL_EDITOR_MENU, _toggle_button)

	var editor_settings := EditorInterface.get_editor_settings()
	_shortcut = Shortcut.new()
	var key_stroke := InputEventKey.new()
	key_stroke.keycode = KEY_G
	_shortcut.events.append(key_stroke)
	editor_settings.add_shortcut(SHORTCUT_PATH, _shortcut)
	_shortcut = editor_settings.get_shortcut(SHORTCUT_PATH)
	_shortcut.changed.connect(_update_tooltip)
	_update_tooltip()

func _exit_tree():
	if _shortcut and _shortcut.changed.is_connected(_update_tooltip):
		_shortcut.changed.disconnect(_update_tooltip)
	remove_node_3d_gizmo_plugin(gizmo_plugin)
	if _toggle_button:
		remove_control_from_container(CONTAINER_SPATIAL_EDITOR_MENU, _toggle_button)
		_toggle_button.queue_free()

func _update_tooltip() -> void:
	var shortcut_text := _shortcut.get_as_text() if _shortcut else ""
	var title := TOOLTIP_TITLE
	if not shortcut_text.is_empty() and shortcut_text != "None":
		title += " (" + shortcut_text + ")"
	_toggle_button.tooltip_text = title + "\n" + TOOLTIP_BODY


func _shortcut_input(event: InputEvent) -> void:
	var editor_settings := EditorInterface.get_editor_settings()
	if editor_settings.is_shortcut(SHORTCUT_PATH, event) and event.is_pressed() and not event.is_echo():
		_toggle_button.button_pressed = not _toggle_button.button_pressed


func _on_sideguard_toggle(pressed: bool) -> void:
	gizmo_plugin.sideguard_mode = pressed
	# Force redraw on all gizmos so handles update immediately.
	var selection := EditorInterface.get_selection().get_selected_nodes()
	for node in selection:
		if node is Node3D:
			node.update_gizmos()
