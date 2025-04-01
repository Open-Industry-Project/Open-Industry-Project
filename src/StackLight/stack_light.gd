@tool
class_name StackLight
extends Node3D


var segment_scene: PackedScene = load("res://src/StackLight/StackSegment.tscn")
var data: StackLightData = load("res://src/StackLight/StackLightData.tres")

var register_tag_ok := false
var tag_group_init := false
var tag_group_original: String

var prev_scale: Vector3

var Segments: int = 1:
	set(value):
		if value == Segments or SimulationEvents.simulation_running:
			return
		var new_value: int = clamp(value, 1, 10)
		if new_value > Segments:
			SpawnSegments(new_value - Segments)
		else:
			RemoveSegments(Segments - new_value)
		Segments = new_value
		FixSegments()
		if segments_container:
			data.set_segments(Segments)
			InitSegments()
			if top_mesh:
				top_mesh.position = Vector3(0, top_mesh_initial_y_pos + (step * (Segments - 1)), 0)
		notify_property_list_changed()
		
var enable_comms := true
@export var tag_group_name: String
var tag_groups:
	set(value):
		tag_group_name = value
		tag_groups = value

var tag_name := ""
	
var step: float = 0.048
var segments_container: Node3D
var top_mesh: MeshInstance3D
var segment_initial_y_pos: float
var top_mesh_initial_y_pos: float = 0.087

var bottom_mesh: MeshInstance3D
var stem_mesh: MeshInstance3D
var mid_mesh: MeshInstance3D

func _get(property: StringName) -> Variant:
	if not segments_container:
		return null
	for i in range(Segments):
		if property == "Light " + str(i + 1):
			var segment = segments_container.get_child(i)
			return segment.segment_data
	return null
	
func _validate_property(property: Dictionary):
	if property.name == "tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
		
func _get_property_list() -> Array:
	var properties = []
	properties.append({
		"name": "Segments",
		"type": TYPE_INT,
		"usage": PROPERTY_USAGE_DEFAULT
	})
	properties.append({
		"name": "data",
		"type": TYPE_OBJECT,
		"usage": PROPERTY_USAGE_NO_EDITOR
	})
	for i in range(Segments - 1, -1, -1):
		properties.append({
			"name": "Light " + str(i + 1),
			"class_name": "StackSegmentData",
			"type": TYPE_OBJECT,
			"usage": PROPERTY_USAGE_DEFAULT
		})
	properties.append({
		"name": "Communications",
		"type": TYPE_NIL,
		"usage": PROPERTY_USAGE_CATEGORY
	})	
	properties.append({
		"name": "enable_comms",
		"type": TYPE_BOOL,
		"usage": PROPERTY_USAGE_DEFAULT
	})
	properties.append({
		"name": "tag_groups",
		"type": 0,
		"usage": PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_STORAGE,
		"hint": 0,
		"hint_string": "tag_group_enum"
	})
	properties.append({
		"name": "tag_name",
		"type": TYPE_STRING,
		"usage": PROPERTY_USAGE_DEFAULT
	})
	return properties

func _ready() -> void:
	data = data.duplicate(true)
	data.init_segments(Segments)
	segments_container = get_node("Mid/Segments")
	top_mesh = get_node("Mid/Top")
	bottom_mesh = get_node("Bottom")
	mid_mesh = get_node("Mid")
	segment_initial_y_pos = segments_container.get_node("StackSegment").position.y
	if segments_container.get_child_count() <= 1:
		SpawnSegments(Segments - 1)
	top_mesh.position = Vector3(0, top_mesh_initial_y_pos + (step * (Segments - 1)), 0)
	InitSegments()
	prev_scale = scale
	Rescale()
	
func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	OIPComms.tag_group_polled.connect(_tag_group_polled)
	
	tag_group_original = tag_group_name
	if(tag_group_name.is_empty()):
		tag_group_name = OIPComms.get_tag_groups()[0]

	tag_groups = tag_group_name


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)

func _on_simulation_started() -> void:
	if enable_comms:
		for i in range(Segments):
			var segment: StackSegmentData = get("Light " + str(i + 1))
			OIPComms.register_tag(segment.tag_group_name, segment.tag_name, 1)
			
			# create hash map that links the tag group name to the tag/stack segment
			#if segment.tag_group_name not in tags_by_group:
				#tags_by_group[segment.tag_group_name] = {}
			#
			#tags_by_group[segment.tag_group_name][segment.tag_name] = segment
		
func _tag_group_polled(_tag_group_name: String) -> void:
	if not enable_comms: return
	#if _tag_group_name in tags_by_group:
		#for tag_name in tags_by_group[_tag_group_name]:
			#var segment: StackSegmentData = tags_by_group[_tag_group_name][tag_name]
			#segment.active = OIPComms.read_bit(_tag_group_name, tag_name)

func _process(delta: float) -> void:
	if scale != prev_scale:
		Rescale()
	prev_scale = scale

func Rescale() -> void:
	scale = Vector3(scale.x, scale.y, scale.x)
	bottom_mesh.scale = Vector3(1, 1 / scale.y, 1)
	mid_mesh.scale = Vector3(1, (1 / scale.y) * scale.x, 1)


func InitSegments() -> void:
	for i in range(Segments):
		var segment = segments_container.get_child(i)
		segment.segment_data = data.segment_datas[i]

func SpawnSegments(count: int) -> void:
	if Segments == 0 or segments_container == null:
		return
	for i in range(count):
		var segment = segment_scene.instantiate() as Node3D
		segments_container.add_child(segment, true)
		segment.owner = self
		segment.position = Vector3(0, segment_initial_y_pos + (step * segment.get_index()), 0)

func RemoveSegments(count: int) -> void:
	for i in range(count):
		var child_index = segments_container.get_child_count() - 1 - i
		segments_container.get_child(child_index).queue_free()

func FixSegments() -> void:
	var child_count: int = segments_container.get_child_count()
	var difference: int = child_count - Segments
	if difference <= 0:
		return
	for i in range(difference):
		segments_container.get_child(segments_container.get_child_count() - 1 - i).queue_free()
