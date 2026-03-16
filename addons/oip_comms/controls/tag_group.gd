@tool
class_name _OIPCommsTagGroup
extends Control

signal tag_group_delete(t: _OIPCommsTagGroup)
signal tag_group_save(t: _OIPCommsTagGroup)

var save_data := {}

@onready var _name: LineEdit = $Row1/Name
@onready var polling_rate: SpinBox = $Row1/PollingRate
@onready var protocol: OptionButton = $Row1/Protocol
@onready var gateway: LineEdit = $Row2/Gateway
@onready var path: LineEdit = $Row2/Path
@onready var cpu: OptionButton = $Row2/CPURow/CPU
@onready var cpu_row: HBoxContainer = $Row2/CPURow
@onready var path_label: Label = $Row2/PathLabel
@onready var gateway_label: Label = $Row2/GatewayLabel
@onready var browse_opc_ua: Button = $Row2/BrowseOpcUa

var loading_complete := false

func _ready() -> void:
	_load()
	update_protocol(protocol.selected, true)

func save() -> void:
	save_data["name"] = _name.text
	save_data["polling_rate"] = str(int(polling_rate.value))
	save_data["protocol"] = str(protocol.selected)
	save_data["gateway"] = gateway.text
	save_data["path"] = path.text
	save_data["cpu"] = cpu.text

func lock_name() -> void:
	if _name:
		_name.editable = false

func _load() -> void:
	if "name" in save_data:
		_name.text = save_data["name"]
		if save_data.get("saved", false):
			_name.editable = false
		polling_rate.value = int(save_data["polling_rate"])
		protocol.select(int(save_data["protocol"]))
		gateway.text = save_data["gateway"]
		path.text = save_data["path"]
		cpu.text = save_data["cpu"]
		loading_complete = true

func _on_Delete_pressed() -> void:
	tag_group_delete.emit(self)

func _on_text_changed(_new_text: String) -> void:
	if loading_complete:
		save()
		tag_group_save.emit(self)

func _on_Gateway_text_changed(_new_text: String) -> void:
	_on_text_changed(_new_text)

func _on_Path_text_changed(_new_text: String) -> void:
	_on_text_changed(_new_text)

func update_protocol(_index: int, from_ready := false) -> void:
	if _index == 2:  # opc_ua
		cpu_row.hide()
		path_label.hide()
		path.hide()
		browse_opc_ua.show()
		gateway_label.text = "Endpoint"

		if not from_ready:
			gateway.text = "opc.tcp://localhost:4840"
	elif _index == 1:  # modbus_tcp
		cpu_row.hide()
		browse_opc_ua.hide()
		path_label.show()
		path.show()
		path_label.text = "Unit ID"
		gateway_label.text = "Gateway"

		if not from_ready:
			gateway.text = "localhost"
			path.text = "1"
	else:  # ab_eip
		cpu_row.show()
		browse_opc_ua.hide()
		path_label.show()
		path.show()
		path_label.text = "Path"
		gateway_label.text = "Gateway"
		cpu.select(max(cpu.selected, 0))

		if not from_ready:
			gateway.text = "localhost"
			path.text = "1,0"

func _on_item_selected(_index: int) -> void:
	update_protocol(protocol.selected)
	if loading_complete:
		save()
		tag_group_save.emit(self)

func _on_value_changed(_value: float) -> void:
	if loading_complete:
		save()
		tag_group_save.emit(self)

func _on_browse_opc_ua_pressed() -> void:
	if not Engine.has_meta("opc_ua_browser_dock"):
		push_warning("OPC UA Browser dock not found. Enable the OPC UA Browser plugin.")
		return
	var dock: EditorDock = Engine.get_meta("opc_ua_browser_dock")
	dock.make_visible()
	if Engine.has_meta("opc_ua_browser_content"):
		var browser = Engine.get_meta("opc_ua_browser_content")
		browser.connect_to_endpoint(gateway.text.strip_edges())
