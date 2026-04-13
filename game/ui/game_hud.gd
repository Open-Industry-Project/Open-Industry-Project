extends Control
## In-game HUD: top toolbar, left-side parts catalogue and bottom status bar.
##
## The parts catalogue lists every *.tscn file in res://parts/ (excluding
## Building.tscn which is loaded automatically).  Clicking a part activates
## placement mode; toolbar buttons switch between Select / Move / Rotate /
## Delete modes.

signal part_selected(scene_path: String)
signal mode_changed(mode: String)
signal simulation_pause_requested

# ── Nodes built at runtime ───────────────────────────────────────────────────

var _toolbar: HBoxContainer
var _mode_buttons: Dictionary = {}  # mode_name -> Button
var _parts_panel: PanelContainer
var _parts_list: ItemList
var _search_bar: LineEdit
var _status_label: Label
var _pause_button: Button

var _current_mode: String = "select"

# Part catalogue data.  Each entry: { "name": String, "path": String }
var _parts: Array[Dictionary] = []

# ── Categories for the parts ─────────────────────────────────────────────────

const CATEGORIES: Dictionary = {
	"All": [],
	"Conveyors": [
		"BeltConveyor", "BeltSpurConveyor", "CurvedBeltConveyor",
		"RollerConveyor", "CurvedRollerConveyor", "RollerSpurConveyor",
	],
	"Sensors": [
		"LaserSensor", "ColorSensor", "DiffuseSensor",
	],
	"Equipment": [
		"SixAxisRobot", "Gantry", "StackLight", "PushButton",
		"Diverter", "ChainTransfer", "BladeStop",
	],
	"Spawners": [
		"BoxSpawner", "PalletSpawner", "Despawner",
	],
	"Objects": [
		"Box", "Pallet",
	],
	"Attachments": [
		"ConveyorLeg", "ConveyorLegC", "SideGuardsCBC",
	],
}

var _category_tabs: TabBar
var _current_category: String = "All"


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_scan_parts()
	_build_ui()
	_populate_parts_list()


# ── Part scanning ────────────────────────────────────────────────────────────

func _scan_parts() -> void:
	_parts.clear()
	var dir := DirAccess.open("res://parts")
	if not dir:
		return
	dir.list_dir_begin()
	var file_name := dir.get_next()
	while file_name != "":
		if file_name.ends_with(".tscn") and file_name != "Building.tscn":
			var base_name := file_name.get_basename()
			_parts.append({
				"name": _humanize(base_name),
				"base": base_name,
				"path": "res://parts/" + file_name,
			})
		file_name = dir.get_next()
	dir.list_dir_end()
	_parts.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a["name"] < b["name"])

	# Also scan assemblies sub-directory.
	var asm_dir := DirAccess.open("res://parts/assemblies")
	if asm_dir:
		asm_dir.list_dir_begin()
		file_name = asm_dir.get_next()
		while file_name != "":
			if file_name.ends_with(".tscn"):
				var base_name := file_name.get_basename()
				_parts.append({
					"name": _humanize(base_name) + " (Assembly)",
					"base": base_name,
					"path": "res://parts/assemblies/" + file_name,
				})
			file_name = asm_dir.get_next()
		asm_dir.list_dir_end()


static func _humanize(pascal: String) -> String:
	# "BeltConveyor" → "Belt Conveyor"
	var result := ""
	for i in range(pascal.length()):
		var c := pascal[i]
		if i > 0 and c == c.to_upper() and c != c.to_lower():
			var prev := pascal[i - 1]
			if prev != prev.to_upper() or prev == prev.to_lower():
				result += " "
		result += c
	return result


# ── UI construction ──────────────────────────────────────────────────────────

func _build_ui() -> void:
	# ── Top toolbar ──────────────────────────────────────────────────────
	var top_bar := PanelContainer.new()
	top_bar.mouse_filter = Control.MOUSE_FILTER_STOP
	var top_style := StyleBoxFlat.new()
	top_style.bg_color = Color(0.14, 0.14, 0.18, 0.92)
	top_bar.add_theme_stylebox_override("panel", top_style)
	top_bar.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
	top_bar.custom_minimum_size.y = 44
	add_child(top_bar)

	_toolbar = HBoxContainer.new()
	_toolbar.alignment = BoxContainer.ALIGNMENT_CENTER
	_toolbar.add_theme_constant_override("separation", 6)
	top_bar.add_child(_toolbar)

	for mode_name: String in ["select", "move", "rotate", "delete"]:
		var btn := Button.new()
		btn.text = mode_name.capitalize()
		btn.toggle_mode = true
		btn.button_pressed = (mode_name == "select")
		btn.custom_minimum_size = Vector2(80, 34)
		btn.pressed.connect(_on_mode_button_pressed.bind(mode_name))
		_toolbar.add_child(btn)
		_mode_buttons[mode_name] = btn

	# Spacer.
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_toolbar.add_child(spacer)

	# Pause / Resume button.
	_pause_button = Button.new()
	_pause_button.text = "⏸  Pause"
	_pause_button.custom_minimum_size = Vector2(100, 34)
	_pause_button.pressed.connect(func() -> void: simulation_pause_requested.emit())
	_toolbar.add_child(_pause_button)

	# ── Left parts panel ────────────────────────────────────────────────
	_parts_panel = PanelContainer.new()
	_parts_panel.mouse_filter = Control.MOUSE_FILTER_STOP
	var panel_style := StyleBoxFlat.new()
	panel_style.bg_color = Color(0.12, 0.12, 0.16, 0.94)
	panel_style.corner_radius_top_right = 6
	panel_style.corner_radius_bottom_right = 6
	_parts_panel.add_theme_stylebox_override("panel", panel_style)
	_parts_panel.anchor_top = 0.0
	_parts_panel.anchor_bottom = 1.0
	_parts_panel.anchor_left = 0.0
	_parts_panel.anchor_right = 0.0
	_parts_panel.offset_top = 50
	_parts_panel.offset_bottom = -40
	_parts_panel.offset_right = 250
	add_child(_parts_panel)

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 4)
	_parts_panel.add_child(vbox)

	# Title.
	var title := Label.new()
	title.text = "  Equipment"
	title.add_theme_font_size_override("font_size", 18)
	vbox.add_child(title)

	# Search.
	_search_bar = LineEdit.new()
	_search_bar.placeholder_text = "Search..."
	_search_bar.clear_button_enabled = true
	_search_bar.text_changed.connect(func(_t: String) -> void: _populate_parts_list())
	vbox.add_child(_search_bar)

	# Category tabs.
	_category_tabs = TabBar.new()
	for cat_name: String in CATEGORIES.keys():
		_category_tabs.add_tab(cat_name)
	_category_tabs.tab_changed.connect(_on_category_changed)
	vbox.add_child(_category_tabs)

	# Parts list.
	_parts_list = ItemList.new()
	_parts_list.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_parts_list.icon_mode = ItemList.ICON_MODE_LEFT
	_parts_list.fixed_icon_size = Vector2i(32, 32)
	_parts_list.item_clicked.connect(_on_part_clicked)
	vbox.add_child(_parts_list)

	# ── Bottom status bar ────────────────────────────────────────────────
	var bottom_bar := PanelContainer.new()
	bottom_bar.mouse_filter = Control.MOUSE_FILTER_STOP
	var bot_style := StyleBoxFlat.new()
	bot_style.bg_color = Color(0.14, 0.14, 0.18, 0.92)
	bottom_bar.add_theme_stylebox_override("panel", bot_style)
	bottom_bar.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
	bottom_bar.custom_minimum_size.y = 32
	add_child(bottom_bar)

	_status_label = Label.new()
	_status_label.text = "  Click a part to place it, or use the toolbar to select/move/rotate/delete objects."
	bottom_bar.add_child(_status_label)


# ── Parts list population ────────────────────────────────────────────────────

func _populate_parts_list() -> void:
	_parts_list.clear()
	var filter := _search_bar.text.strip_edges().to_lower() if _search_bar else ""
	var cat_items: Array = CATEGORIES.get(_current_category, [])

	for part: Dictionary in _parts:
		var part_name: String = part["name"]
		var base: String = part["base"]

		# Category filter.
		if _current_category != "All" and not cat_items.has(base):
			continue

		# Text filter.
		if filter != "" and part_name.to_lower().find(filter) == -1:
			continue

		_parts_list.add_item(part_name)
		_parts_list.set_item_metadata(_parts_list.item_count - 1, part["path"])


# ── Callbacks ────────────────────────────────────────────────────────────────

func _on_mode_button_pressed(mode_name: String) -> void:
	_set_mode(mode_name)


func _on_category_changed(idx: int) -> void:
	_current_category = CATEGORIES.keys()[idx]
	_populate_parts_list()


func _on_part_clicked(index: int, _at_position: Vector2, _button: int) -> void:
	var path: String = _parts_list.get_item_metadata(index)
	if path:
		part_selected.emit(path)
		set_status("Placing: %s  (Left-click = place, R = rotate, Right-click = cancel)" % _parts_list.get_item_text(index))


# ── Public API ───────────────────────────────────────────────────────────────

func set_mode(mode_name: String) -> void:
	_set_mode(mode_name)


func set_status(text: String) -> void:
	if _status_label:
		_status_label.text = "  " + text


func update_pause_button(paused: bool) -> void:
	if _pause_button:
		_pause_button.text = "▶  Resume" if paused else "⏸  Pause"


func _set_mode(mode_name: String) -> void:
	_current_mode = mode_name
	for key: String in _mode_buttons:
		(_mode_buttons[key] as Button).button_pressed = (key == mode_name)
	mode_changed.emit(mode_name)

	match mode_name:
		"select":
			set_status("Click an object to select it.")
		"move":
			set_status("Select an object, then press G to grab and move it.")
		"rotate":
			set_status("Select an object, then press R to rotate 90°.")
		"delete":
			set_status("Click an object to delete it.")
