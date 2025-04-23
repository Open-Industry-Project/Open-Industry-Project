@tool
class_name StackLight
extends Node3D


var segment_scene: PackedScene = load("res://src/StackLight/StackSegment.tscn")
var data: StackLightData = load("res://src/StackLight/StackLightData.tres")

var prev_scale: Vector3

var Segments: int = 1:
	set(value):
		var new_value: int = clamp(value, 1, 10)
		if new_value == Segments: return
		
		Segments = new_value 

		if segments_container:
			data.set_segments(Segments) 

			var current_child_count = segments_container.get_child_count()
			var difference = Segments - current_child_count

			if difference > 0:
				SpawnSegments(difference)
			elif difference < 0:
				RemoveSegments(-difference)

			InitSegments()
			
			# If segments were removed, mask the light value
			var new_light_value = light_value & ((1 << Segments) - 1)
			if new_light_value != light_value:
				light_value = new_light_value
				_update_segment_visuals() 

			if top_mesh:
				top_mesh.position = Vector3(0, top_mesh_initial_y_pos + (step * (Segments - 1)), 0)
		notify_property_list_changed()
		
var light_value = 0:
	set(value):
		var new_val = value % (1 << Segments)
		if new_val == light_value:
			return
		light_value = new_val
		_update_segment_visuals()
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

var register_tag_ok := false
var tag_group_init := false
var tag_group_original: String
var _enable_comms_changed = false:
	set(value):
		notify_property_list_changed()

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
		"name": "light_value",
		"type": TYPE_INT,
		"usage": PROPERTY_USAGE_DEFAULT
	})
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
			"usage": PROPERTY_USAGE_DEFAULT | PROPERTY_USAGE_READ_ONLY
		})
	properties.append({
		"name": "Communications",
		"type": TYPE_NIL,
		"usage": PROPERTY_USAGE_CATEGORY
	})	
	properties.append({
		"name": "enable_comms",
		"type": TYPE_BOOL,
		"usage": PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	})
	properties.append({
		"name": "tag_groups",
		"type": 0,
		"usage": PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_STORAGE  if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE,
		"hint": 0,
		"hint_string": "tag_group_enum"
	})
	properties.append({
		"name": "tag_name",
		"type": TYPE_STRING,
		"usage": PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	})
	return properties

func _ready() -> void:
	data = data.duplicate(true)
	data.init_segments(Segments)
	segments_container = get_node("Mid/Segments")
	top_mesh = get_node("Mid/Top")
	bottom_mesh = get_node("Bottom")
	mid_mesh = get_node("Mid")
	
	var current_child_count = segments_container.get_child_count()
	var difference = Segments - current_child_count

	if difference > 0:
		# Need to add segments
		SpawnSegments(difference)
	elif difference < 0:
		# Need to remove segments (queue_free excess)
		for i in range(-difference):
			var child_to_remove_index = current_child_count - 1 - i
			if child_to_remove_index >= 0:
				var child_node = segments_container.get_child(child_to_remove_index)
				child_node.queue_free()
			else:
				pass # Tried to remove invalid index
	
	if segments_container.get_child_count() > 0:
		segment_initial_y_pos = segments_container.get_child(0).position.y
	else:
		# Need a fallback if all segments are removed (e.g., Segments set to 0, although we clamp to 1)
		segment_initial_y_pos = 0.0
	
	FixSegmentPositions()
	InitSegments()
	
	top_mesh.position = Vector3(0, top_mesh_initial_y_pos + (step * (max(0, Segments - 1))), 0) # Use max(0,...) in case Segments is 0 temporarily
	_update_segment_visuals()
	prev_scale = scale
	Rescale()

func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	OIPComms.tag_group_polled.connect(_tag_group_polled)
	
	tag_group_original = tag_group_name
	if(tag_group_name.is_empty()):
		tag_group_name = OIPComms.get_tag_groups()[0]

	tag_groups = tag_group_name
	
	OIPComms.enable_comms_changed.connect(func() -> void: _enable_comms_changed = OIPComms.get_enable_comms)


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)
	# Disconnect signals from all segments
	if segments_container:
		for i in range(segments_container.get_child_count()):
			var segment_node = segments_container.get_child(i)
			if segment_node.is_connected("active_state_changed", _on_segment_state_changed):
				segment_node.active_state_changed.disconnect(_on_segment_state_changed)

func use() -> void:
	light_value += 1
	
func _on_simulation_started() -> void:
	if enable_comms:
		OIPComms.register_tag(tag_group_name, tag_name, 1)
			
		
func _tag_group_polled(_tag_group_name: String) -> void:
	if not enable_comms: return
	light_value = OIPComms.read_int32(tag_group_name, tag_name)

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
		if i >= segments_container.get_child_count():
			printerr("Mismatch between Segments count and child nodes during InitSegments")
			break 
		var segment_node = segments_container.get_child(i)
		segment_node.segment_data = data.segment_datas[i]
		segment_node.index = i

		if not segment_node.is_connected("active_state_changed", _on_segment_state_changed):
			segment_node.active_state_changed.connect(_on_segment_state_changed)

func SpawnSegments(count: int) -> void:
	if segments_container == null:
		return
	var start_index = segments_container.get_child_count()
	for i in range(count):
		var segment = segment_scene.instantiate() as Node3D
		segments_container.add_child(segment, true)
		segment.owner = self
		var current_index = start_index + i
		segment.index = current_index
		segment.position = Vector3(0, segment_initial_y_pos + (step * current_index), 0)

		if current_index < data.segment_datas.size():
			segment.segment_data = data.segment_datas[current_index]
		else:
			printerr("Not enough data segments available when spawning segment %d" % current_index)
		segment.active_state_changed.connect(_on_segment_state_changed)

func RemoveSegments(count: int) -> void:
	if not segments_container: return
	var current_child_count = segments_container.get_child_count()
	for i in range(count):
		var child_index = current_child_count - 1 - i
		if child_index < 0: break # Should not happen if count is correct
		var segment_node = segments_container.get_child(child_index)

		if segment_node.is_connected("active_state_changed", _on_segment_state_changed):
			segment_node.active_state_changed.disconnect(_on_segment_state_changed)
		segment_node.queue_free()

func _on_segment_state_changed(index: int, active: bool) -> void:
	if index < 0 or index >= Segments:
		printerr("Received state change for invalid index: ", index)
		return
	
	var current_bit = (1 << index)
	var newlight_value: int
	if active:
		newlight_value = light_value | current_bit
	else:
		newlight_value = light_value & ~current_bit
	
	self.light_value = newlight_value 

func _update_segment_visuals() -> void:
	if not is_node_ready() or not segments_container: return
	for i in range(Segments):
		if i < data.segment_datas.size():
			var segment_data: StackSegmentData = data.segment_datas[i]
			var is_active = (light_value >> i) & 1 == 1
			# This prevents recursive signals if _on_segment_state_changed was triggered by inspector
			if segment_data.active != is_active:
				segment_data.active = is_active 
		else:
			# This case handles if Segments count > data array size temporarily
			# Ensure segment visuals are off if no data is present
			if i < segments_container.get_child_count():
				var segment_node = segments_container.get_child(i) as StackSegment
				segment_node._set_active(false) # Directly set visual state

func FixSegmentPositions() -> void:
	if not segments_container: return
	for i in range(segments_container.get_child_count()):
		var segment_node = segments_container.get_child(i)
		segment_node.position = Vector3(0, segment_initial_y_pos + (step * i), 0)
