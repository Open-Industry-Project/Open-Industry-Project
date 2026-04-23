@tool
class_name CurvedBeltConveyorAssembly
extends CurvedConveyorAssemblyBase

const CONVEYOR_CLASS_NAME: String = "CurvedBeltConveyor"
const PREVIEW_SCENE_PATH: String = "res://parts/assemblies/CurvedBeltConveyorAssembly.tscn"

#region ConveyorLegsAssembly properties
@export_group("Conveyor Legs")
@export_custom(PROPERTY_HINT_NONE, "suffix:m")
var floor_plane: Plane = preload(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH).DEFAULT_FLOOR_PLANE:
	get:
		return _legs_property_cached_get(&"floor_plane", floor_plane)
	set(value):
		floor_plane = _legs_property_cached_set(&"floor_plane", value, floor_plane)
var global_floor_plane: Plane = preload(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH).DEFAULT_FLOOR_PLANE:
	get:
		return _legs_property_cached_get(&"global_floor_plane", global_floor_plane)
	set(value):
		global_floor_plane = _legs_property_cached_set(&"global_floor_plane", value, global_floor_plane)
@export_storage
var local_floor_plane: Plane = preload(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH).DEFAULT_FLOOR_PLANE:
	get:
		return _legs_property_cached_get(&"local_floor_plane", local_floor_plane)
	set(value):
		local_floor_plane = _legs_property_cached_set(&"local_floor_plane", value, local_floor_plane)
#endregion


func _get_conveyor_class_name() -> String:
	return CONVEYOR_CLASS_NAME


func _get_preview_scene_path() -> String:
	return PREVIEW_SCENE_PATH


func _get_corner_belt_height(corner: Node) -> float:
	return corner.belt_height
