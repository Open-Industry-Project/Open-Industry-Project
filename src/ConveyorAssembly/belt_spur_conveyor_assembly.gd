@tool
class_name BeltSpurConveyor
extends SpurConveyorAssembly

const CONVEYOR_CLASS_NAME = "BeltConveyor"
const CONVEYOR_SCRIPT_PATH = "res://src/Conveyor/belt_conveyor.gd"
const CONVEYOR_SCRIPT_FILENAME = "belt_conveyor.gd"

var _conveyor_script: Script

# Conveyor properties
# This category annotation will make the properties inherit metadata and docs from the conveyor script.
@export_category(CONVEYOR_SCRIPT_FILENAME)
@export var belt_color: Color = Color(1, 1, 1, 1):
	set(value):
		_set_process_if_changed(belt_color, value)
		belt_color = value
@export var belt_texture: BeltConveyor.ConvTexture = BeltConveyor.ConvTexture.STANDARD:
	set(value):
		_set_process_if_changed(belt_texture, value)
		belt_texture = value
@export var speed: float = 2:
	set(value):
		_set_process_if_changed(speed, value)
		speed = value
		_set_for_all_conveyors(&"speed", value)
	get():
		var conveyor := _get_first_conveyor() as BeltConveyor
		if conveyor:
			return conveyor.speed
		return speed
@export var belt_physics_material: PhysicsMaterial:
	set(value):
		_set_process_if_changed(belt_physics_material, value)
		belt_physics_material = value
		_set_for_all_conveyors(&"belt_physics_material", value)
	get():
		var conveyor := _get_first_conveyor() as BeltConveyor
		if conveyor:
			return conveyor.belt_physics_material
		return belt_physics_material
@export var enable_comms: bool = false:
	set(value):
		_set_process_if_changed(enable_comms, value)
		enable_comms = value
@export var speed_tag_group_name: String:
	set(value):
		_set_process_if_changed(speed_tag_group_name, value)
		speed_tag_group_name = value
@export_custom(0,"tag_group_enum") var speed_tag_groups:
	set(value):
		_set_process_if_changed(speed_tag_groups, value)
		speed_tag_groups = value
@export var speed_tag_name: String = "":
	set(value):
		_set_process_if_changed(speed_tag_name, value)
		speed_tag_name = value
@export var running_tag_group_name: String:
	set(value):
		_set_process_if_changed(running_tag_group_name, value)
		running_tag_group_name = value
@export_custom(0,"tag_group_enum") var running_tag_groups:
	set(value):
		_set_process_if_changed(running_tag_groups, value)
		running_tag_groups = value
@export var running_tag_name: String = "":
	set(value):
		_set_process_if_changed(running_tag_name, value)
		running_tag_name = value


func _init() -> void:
	super()


func _validate_property(property: Dictionary) -> void:
	var property_name = property["name"]
	if property_name == "update_rate" or property_name == "tag":
		property["usage"] = PROPERTY_USAGE_DEFAULT if enable_comms else PROPERTY_USAGE_NO_EDITOR
	if property[&"name"] == CONVEYOR_SCRIPT_FILENAME \
			&& property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		# Link the category to a script.
		# This will make the category show the script class and icon as if we inherited from it.
		assert(CONVEYOR_SCRIPT_PATH.get_file() == CONVEYOR_SCRIPT_FILENAME, "CONVEYOR_SCRIPT_PATH doesn't match CONVEYOR_SCRIPT_FILENAME")
		property[&"hint_string"] = CONVEYOR_SCRIPT_PATH
		return
	if property_name in _get_conveyor_property_names():
		# Copy property info from a conveyor or its script.
		var property_found := false
		if _get_internal_child_count() > 0:
			var conveyor: Node = get_child(0, true)
			# Search for the property.
			var conveyor_properties: Array[Dictionary] = conveyor.get_property_list()
			for property_info in conveyor_properties:
				if property_info["name"] == property_name:
					property.assign(property_info)
					property_found = true
					break
		# Fallback to script if no instance available.
		if not property_found:
			# Search for the property.
			var conveyor_properties: Array[Dictionary] = _get_conveyor_script().get_script_property_list()
			for property_info in conveyor_properties:
				if property_info["name"] == property_name:
					property.assign(property_info)
					property_found = true
					break
	super._validate_property(property)


func _get_conveyor_property_names() -> Array[StringName]:
	var property_names: Array[StringName] = [
		&"belt_color",
		&"belt_texture",
		&"speed",
		&"belt_physics_material",
		&"enable_comms",
		&"speed_tag_group_name",
		&"speed_tag_groups",
		&"speed_tag_name",
		&"running_tag_group_name",
		&"running_tag_groups",
		&"running_tag_name",
	]
	return property_names


func _get_conveyor_script():
	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
	_conveyor_script = load(class_details["path"]) as Script


func _set_conveyor_properties(conveyor: Node) -> void:
	for property_name in _get_conveyor_property_names():
		if property_name in [&"speed_tag_groups", &"running_tag_groups"] and not OIPComms.get_enable_comms():
			continue
		conveyor.set(property_name, get(property_name))


func _set_for_all_conveyors(property: StringName, value: Variant) -> void:
	var conveyor_count = _get_internal_child_count()
	for i in range(conveyor_count):
		var conveyor: Node = get_child(i, true)
		conveyor.set(property, value)


#func _get(property: StringName) -> Variant:
#	if _get_internal_child_count() > 0:
#		var conveyor: Node = get_child(0, true)
#		if property in _get_conveyor_property_names():
#			return conveyor.get(property)
#	return null
