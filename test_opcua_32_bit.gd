@tool
extends Label3D

@export var tag_group_name := "TagGroup0"
@export var tag_name := "TEST_DINT"

func _enter_tree() -> void:
	#print("enter")
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	OIPComms.tag_group_polled.connect(_tag_group_polled)

func _exit_tree() -> void:
	#print("exit")
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)

func _on_simulation_started() -> void:
	OIPComms.register_tag(tag_group_name, tag_name, 1)
	
func _tag_group_polled(_tag_group_name: String) -> void:
	if _tag_group_name == tag_group_name:
		text = str(OIPComms.read_int32(tag_group_name, tag_name))
