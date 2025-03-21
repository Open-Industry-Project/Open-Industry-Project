@tool

# TBD -> figure out how to programmatically disable these classes from editor
# end user does not need to see them
# https://forum.godotengine.org/t/how-to-exclude-custom-classes-from-the-create-new-node-menu/51269/9
# right now the type hints are useful
class_name _OIPCommsDock
extends Control

signal save_changes(value: bool)

const TAG_GROUPS_FILE := "res://addons/oip_comms/save_data/tag_groups.json"
const TAG_GROUP = preload("res://addons/oip_comms/controls/tag_group.tscn")

@onready var v_box_container: VBoxContainer = $ScrollContainer/VBoxContainer
@onready var enable_comms: CheckBox = $HFlowContainer2/EnableComms

var tag_groups_data: Array = []
var last_tag_groups_data: Array = []
var changes_present := false

func _ready() -> void:
	
	load_tag_groups_data()
	load_tag_groups_ui()
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
	if FileAccess.file_exists(TAG_GROUPS_FILE):
		var save_file := FileAccess.open(TAG_GROUPS_FILE, FileAccess.READ)
		var json_string := save_file.get_line()
		tag_groups_data = JSON.parse_string(json_string)
		
		save_file.close()
	
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
		
	# last tag group data indicates the last time it was saved
	last_tag_groups_data = buffer_tag_groups_data
	
	register_tag_groups()

func save_tag_groups_ui() -> void:
	tag_groups_data = []
	for tag_group: _OIPCommsTagGroup in v_box_container.get_children():
		tag_group.save()
		tag_groups_data.push_back(tag_group.save_data)

func save_tag_groups_data() -> void:
	var save_file := FileAccess.open(TAG_GROUPS_FILE, FileAccess.WRITE)
	var json_string := JSON.stringify(tag_groups_data)
	save_file.store_line(json_string)
	save_file.close()

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

# old save button
func _on_Button_pressed() -> void:
	save_tag_groups_ui()
	save_tag_groups_data()

# old load button
func _on_Button2_pressed() -> void:
	load_tag_groups_data()
	load_tag_groups_ui()

func _on_AddTagGroup_pressed() -> void:
	var _name := "TagGroup" + str(len(tag_groups_data))
	tag_groups_data.push_back({
		"name": _name, "polling_rate": "500", "protocol": "ab_eip",
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

func _on_EnableComms_toggled(toggled_on: bool) -> void:
	OIPComms.set_enable_comms(toggled_on)

func _on_EnableLogging_toggled(toggled_on: bool) -> void:
	OIPComms.set_enable_log(toggled_on)

func _on_simulation_started() -> void:
	OIPComms.set_sim_running(true)

func _on_simulation_ended() -> void:
	OIPComms.set_sim_running(false)
