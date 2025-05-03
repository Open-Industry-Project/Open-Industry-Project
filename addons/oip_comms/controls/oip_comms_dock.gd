@tool

# TBD -> figure out how to programmatically disable these classes from editor
# end user does not need to see them
# https://forum.godotengine.org/t/how-to-exclude-custom-classes-from-the-create-new-node-menu/51269/9
# right now the type hints are useful
class_name _OIPCommsDock
extends Control

signal save_changes(value: bool)

const TAG_GROUPS_FILE := "res://addons/oip_comms/save_data/tag_groups.cfg"
const SETTINGS_FILE := "res://addons/oip_comms/save_data/settings.cfg"
const TAG_GROUP = preload("res://addons/oip_comms/controls/tag_group.tscn")

@onready var v_box_container: VBoxContainer = $ScrollContainer/VBoxContainer
@onready var enable_comms: CheckBox = $HFlowContainer2/EnableComms
@onready var enable_logging: CheckBox = $HFlowContainer2/EnableLogging

var tag_groups_data: Array = []
var last_tag_groups_data: Array = []
var changes_present := false
var settings_config: ConfigFile = ConfigFile.new()
var tag_groups_config: ConfigFile = ConfigFile.new()


func _ready() -> void:
	load_tag_groups_data()
	load_tag_groups_ui()
	load_settings()
	register_tag_groups()
	
	last_tag_groups_data = tag_groups_data.duplicate(true)
	
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)

	OIPComms.set_enable_comms(enable_comms.button_pressed)

func _process(_delta: float) -> void:
	if tag_groups_data.hash() != last_tag_groups_data.hash():
		if not changes_present:
			changes_present = true
			save_changes.emit(changes_present)

func load_tag_groups_data() -> void:
	tag_groups_data = []
	
	var error = tag_groups_config.load(TAG_GROUPS_FILE)
	if error == OK:
		var group_count = tag_groups_config.get_value("info", "group_count", 0)
		
		for i in range(group_count):
			var group_section = "group_" + str(i)
			var group_data = {
				"name": tag_groups_config.get_value(group_section, "name", "TagGroup" + str(i)),
				"polling_rate": tag_groups_config.get_value(group_section, "polling_rate", "500"),
				"protocol": tag_groups_config.get_value(group_section, "protocol", "0"),
				"gateway": tag_groups_config.get_value(group_section, "gateway", "localhost"),
				"path": tag_groups_config.get_value(group_section, "path", "1,0"),
				"cpu": tag_groups_config.get_value(group_section, "cpu", "ControlLogix")
			}
			tag_groups_data.append(group_data)

func load_settings() -> void:
	var error = settings_config.load(SETTINGS_FILE)
	
	if error == OK:
		enable_comms.button_pressed = settings_config.get_value("settings", "enable_comms", false)
		#TODO a bug is making this always false.
		#enable_logging.button_pressed = settings_config.get_value("settings", "enable_logging", false)

func load_tag_groups_ui() -> void:
	for tag_group: _OIPCommsTagGroup in v_box_container.get_children():
		tag_group.queue_free()
	
	for tag_group_data: Dictionary in tag_groups_data:
		var tag_group := TAG_GROUP.instantiate()
		tag_group.save_data = tag_group_data.duplicate()
		tag_group.tag_group_delete.connect(tag_group_delete)
		tag_group.tag_group_save.connect(tag_group_save)
		v_box_container.add_child(tag_group)

func tag_group_save(_t: _OIPCommsTagGroup) -> void:
	save_tag_groups_ui()

func save_all() -> void:
	changes_present = false
	save_changes.emit(changes_present)

	save_tag_groups_ui()
	var buffer_tag_groups_data := tag_groups_data.duplicate(true)
	
	if last_tag_groups_data.hash() != tag_groups_data.hash():
		save_tag_groups_data()
		print("OIP Comms: Tag group data saved")
	
	save_settings()
	
	# last tag group data indicates the last time it was saved
	last_tag_groups_data = buffer_tag_groups_data
	
	register_tag_groups()

func save_tag_groups_ui() -> void:
	tag_groups_data = []
	for tag_group: _OIPCommsTagGroup in v_box_container.get_children():
		tag_group.save()
		tag_groups_data.push_back(tag_group.save_data)

func save_tag_groups_data() -> void:
	tag_groups_config.clear()
	
	tag_groups_config.set_value("info", "group_count", tag_groups_data.size())
	
	for i in range(tag_groups_data.size()):
		var group_data = tag_groups_data[i]
		var group_section = "group_" + str(i)
		
		tag_groups_config.set_value(group_section, "name", group_data.name)
		tag_groups_config.set_value(group_section, "polling_rate", group_data.polling_rate)
		tag_groups_config.set_value(group_section, "protocol", group_data.protocol)
		tag_groups_config.set_value(group_section, "gateway", group_data.gateway)
		tag_groups_config.set_value(group_section, "path", group_data.path)
		tag_groups_config.set_value(group_section, "cpu", group_data.cpu)
	
	tag_groups_config.save(TAG_GROUPS_FILE)


func tag_group_delete(t: _OIPCommsTagGroup) -> void:
	var index := -1
	
	var i := 0
	for tag_group: _OIPCommsTagGroup in v_box_container.get_children():
		if tag_group == t:
			index = i
			break
		i += 1
	
	if index != -1:
		tag_groups_data.remove_at(index)
		t.queue_free()

func _on_AddTagGroup_pressed() -> void:
	var _name := "TagGroup" + str(len(tag_groups_data))
	tag_groups_data.push_back({
		"name": _name, "polling_rate": "500", "protocol": "0",
		"gateway": "localhost", "path": "1,0", "cpu": "ControlLogix"
	})
	load_tag_groups_ui()

func register_tag_groups() -> void:
	OIPComms.clear_tag_groups()
	for tag_group_data: Dictionary in tag_groups_data:
		var n: String = tag_group_data.name
		var pr: String = tag_group_data.polling_rate
		
		var pt_num: String = tag_group_data.protocol
		
		var pt := ""
		if pt_num == "0": pt = "ab_eip"
		elif pt_num == "1": pt = "modbus_tcp"
		elif pt_num == "2": pt = "opc_ua"
		
		var g: String = tag_group_data.gateway
		var p: String = tag_group_data.path
		var c: String = tag_group_data.cpu
		OIPComms.register_tag_group(n, int(pr), pt, g, p, c)
	OIPComms.tag_groups_registered.emit()

func _on_EnableComms_toggled(toggled_on: bool) -> void:
	OIPComms.set_enable_comms(toggled_on)
	OIPComms.enable_comms_changed.emit()
	save_settings()

func _on_EnableLogging_toggled(toggled_on: bool) -> void:
	OIPComms.set_enable_log(toggled_on)
	save_settings()

func _on_simulation_started() -> void:
	OIPComms.set_sim_running(true)

func _on_simulation_ended() -> void:
	OIPComms.set_sim_running(false)

func save_settings() -> void:
	settings_config.set_value("settings", "enable_comms", enable_comms.button_pressed)
	settings_config.set_value("settings", "enable_logging", enable_logging.button_pressed)
	
	var error = settings_config.save(SETTINGS_FILE)
