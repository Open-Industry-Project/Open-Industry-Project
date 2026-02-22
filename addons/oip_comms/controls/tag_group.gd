@tool
class_name _OIPCommsTagGroup
extends Control

signal tag_group_delete(t: _OIPCommsTagGroup)
signal tag_group_save(t: _OIPCommsTagGroup)

enum ByteOrder { DEFAULT, BIG_ENDIAN_ABCD, WORD_SWAPPED_CDAB, BYTE_SWAPPED_BADC, LITTLE_ENDIAN_DCBA }

const BYTE_ORDER_VALUES: Array[String] = ["", "3210", "2301", "1032", "0123"]

var save_data := {}

@onready var _name: LineEdit = $Name
@onready var polling_rate: SpinBox = $PollingRate
@onready var protocol: OptionButton = $Protocol
@onready var gateway: LineEdit = $Gateway
@onready var path: LineEdit = $Path
@onready var cpu: OptionButton = $CPU
@onready var cpu_label: Label = $CPULabel
@onready var path_label: Label = $PathLabel
@onready var gateway_label: Label = $GatewayLabel
@onready var byte_order: OptionButton = $ByteOrder
@onready var byte_order_label: Label = $ByteOrderLabel

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
	save_data["byte_order"] = str(byte_order.selected)

func _load() -> void:
	if "name" in save_data:
		_name.text = save_data["name"]
		polling_rate.value = int(save_data["polling_rate"])
		protocol.select(int(save_data["protocol"]))
		gateway.text = save_data["gateway"]
		path.text = save_data["path"]
		cpu.text = save_data["cpu"]
		byte_order.select(int(save_data.get("byte_order", "0")))
		loading_complete = true

func _on_Delete_pressed() -> void:
	tag_group_delete.emit(self)

func _on_text_changed(_new_text: String) -> void:
	if loading_complete:
		save()
		tag_group_save.emit(self)

func _on_Gateway_text_changed(_new_text: String) -> void:
	# this is wrong, and now handled on the GDextension side
	#if _new_text.to_lower() == "localhost":
	#	gateway.text = "127.0.0.1"
	_on_text_changed(_new_text)

func _on_Path_text_changed(_new_text: String) -> void:
	if protocol.text == "opc_ua" and not _new_text.is_valid_int():
		path.text = ""
	
	_on_text_changed(_new_text)
	
func update_protocol(_index: int, from_ready := false) -> void:
	if _index == 2:  # opc_ua
		cpu.hide()
		cpu_label.hide()
		byte_order.hide()
		byte_order_label.hide()
		path_label.text = "Namespace"
		gateway_label.text = "Endpoint"
		
		if not from_ready:
			gateway.text = "opc.tcp://localhost:4840"
			if protocol.text == "opc_ua" and not path.text.is_valid_int():
				path.text = "1"
	elif _index == 1:  # modbus_tcp
		cpu.hide()
		cpu_label.hide()
		byte_order.show()
		byte_order_label.show()
		path_label.text = "Unit ID"
		gateway_label.text = "Gateway"
		
		if not from_ready:
			gateway.text = "localhost"
			path.text = "1"
			cpu.text = ""
	else:  # ab_eip
		cpu.show()
		cpu_label.show()
		byte_order.hide()
		byte_order_label.hide()
		path_label.text = "Path"
		gateway_label.text = "Gateway"
		
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
