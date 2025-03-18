@tool
class_name _OIPCommsTagGroup
extends Control

signal tag_group_delete(t: _OIPCommsTagGroup)
signal tag_group_save(t: _OIPCommsTagGroup)

var save_data := {}

@onready var _name: LineEdit = $Panel/Name
@onready var polling_rate: SpinBox = $Panel/PollingRate
@onready var protocol: OptionButton = $Panel/Protocol
@onready var gateway: LineEdit = $Panel/Gateway
@onready var path: LineEdit = $Panel/Path
@onready var cpu: OptionButton = $Panel/CPU
@onready var cpu_label: Label = $Panel/CPULabel
@onready var path_label: Label = $Panel/PathLabel
@onready var gateway_label: Label = $Panel/GatewayLabel


var loading_complete := false

func _ready() -> void:
	_load()
	update_protocol(protocol.selected)

func save() -> void:
	save_data["name"] = _name.text
	save_data["polling_rate"] = str(int(polling_rate.value))
	save_data["protocol"] = str(protocol.selected)
	save_data["gateway"] = gateway.text
	save_data["path"] = path.text
	save_data["cpu"] = cpu.text

func _load() -> void:
	if "name" in save_data:
		_name.text = save_data["name"]
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
	# this is wrong, and now handled on the GDextension side
	#if _new_text.to_lower() == "localhost":
	#	gateway.text = "127.0.0.1"
	
	if loading_complete:
		save()
		tag_group_save.emit(self)

func update_protocol(_index: int) -> void:
	if _index == 2:
		cpu.hide()
		cpu_label.hide()
		path_label.text = "Namespace"
		gateway_label.text = "Endpoint"
	else:
		cpu.show()
		cpu_label.show()
		path_label.text = "Path"
		gateway_label.text = "Gateway"

func _on_item_selected(_index: int) -> void:
	update_protocol(_index)
	if loading_complete:
		save()
		tag_group_save.emit(self)

func _on_value_changed(_value: float) -> void:
	if loading_complete:
		save()
		tag_group_save.emit(self)
