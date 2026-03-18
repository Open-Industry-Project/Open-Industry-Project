@tool
extends VBoxContainer

@onready var endpoint_label: Label = $EndpointPanel/EndpointHBox/EndpointLabel
@onready var refresh_button: Button = $EndpointPanel/EndpointHBox/RefreshButton
@onready var browse_tree: Tree = $BrowseTree
@onready var details_label: RichTextLabel = $NodeDetails/DetailsLabel
@onready var copy_button: Button = $CopyButton

var comms: Object
var connected := false
var current_endpoint := ""

func _ready() -> void:
	copy_button.pressed.connect(_on_copy_pressed)
	refresh_button.pressed.connect(_on_refresh_pressed)
	var editor_base := EditorInterface.get_base_control()
	if editor_base:
		refresh_button.icon = editor_base.get_theme_icon("Reload", "EditorIcons")
	browse_tree.item_collapsed.connect(_on_item_collapsed)
	browse_tree.item_selected.connect(_on_item_selected)
	browse_tree.columns = 1

func _get_comms() -> Object:
	if comms == null:
		comms = Engine.get_singleton("OIPComms")
	return comms

func connect_to_endpoint(endpoint: String) -> void:
	var c := _get_comms()
	if c == null:
		push_error("OIPComms singleton not found")
		return

	if endpoint.strip_edges().is_empty():
		return

	if connected and current_endpoint == endpoint:
		return

	if connected:
		c.browse_disconnect()
		browse_tree.clear()
		connected = false

	if c.browse_connect(endpoint):
		connected = true
		current_endpoint = endpoint
		endpoint_label.text = endpoint
		endpoint_label.add_theme_color_override("font_color", Color(0.5, 0.85, 0.5))
		_load_root()
	else:
		endpoint_label.text = "Failed to connect"
		endpoint_label.add_theme_color_override("font_color", Color(0.9, 0.35, 0.35))

func _load_root() -> void:
	browse_tree.clear()
	var root := browse_tree.create_item()
	root.set_text(0, "Objects")
	root.set_metadata(0, "ns=0;i=85")
	_add_placeholder(root)
	root.collapsed = false
	_load_children(root)

func _on_item_collapsed(item: TreeItem) -> void:
	if item.collapsed:
		return
	if item.get_child_count() == 1 and item.get_first_child().get_text(0) == "":
		_load_children.call_deferred(item)

func _load_children(parent_item: TreeItem) -> void:
	var c := _get_comms()
	if c == null or not connected:
		return

	var node_id: String = parent_item.get_metadata(0)
	var children: Array = c.browse_children(node_id)

	for child in parent_item.get_children():
		parent_item.remove_child(child)
		child.free()

	for entry in children:
		var child_item := browse_tree.create_item(parent_item)
		var display: String = entry["display_name"]
		var nc: String = entry["node_class"]
		child_item.set_text(0, display + "  [" + nc + "]")
		child_item.set_metadata(0, entry["node_id"])

		if nc == "Object" or nc == "View":
			_add_placeholder(child_item)
			child_item.collapsed = true
		elif nc == "Variable":
			child_item.set_custom_color(0, Color(0.5, 0.85, 0.5))
			_add_placeholder(child_item)
			child_item.collapsed = true

func _add_placeholder(item: TreeItem) -> void:
	var placeholder := browse_tree.create_item(item)
	placeholder.set_text(0, "")

func _on_item_selected() -> void:
	var selected := browse_tree.get_selected()
	if selected == null:
		details_label.text = "Select a node to view details."
		return

	var node_id: String = selected.get_metadata(0)
	if node_id.is_empty():
		return

	var c := _get_comms()
	if c == null or not connected:
		return

	var info: Dictionary = c.browse_node_info(node_id)
	if info.is_empty():
		details_label.text = "Failed to read node info."
		return

	var text := ""
	text += "[b]NodeId:[/b] " + info.get("node_id", "") + "\n"
	var type_str: String = info.get("type", "")
	if not type_str.is_empty():
		text += "[b]Type:[/b] " + type_str + "\n"
	var value_str: String = info.get("value", "")
	if not value_str.is_empty():
		text += "[b]Value:[/b] " + value_str + "\n"
	var access_str: String = info.get("access", "")
	if not access_str.is_empty():
		text += "[b]Access:[/b] " + access_str + "\n"
	var desc_str: String = info.get("description", "")
	if not desc_str.is_empty():
		text += "[b]Desc:[/b] " + desc_str

	details_label.text = text

func _on_refresh_pressed() -> void:
	if not connected:
		return
	_load_root()

func _on_copy_pressed() -> void:
	var selected := browse_tree.get_selected()
	if selected == null:
		return
	var node_id: String = selected.get_metadata(0)
	if node_id.is_empty():
		return
	DisplayServer.clipboard_set(node_id)
