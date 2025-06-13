@tool
extends Node

signal simulation_started
signal simulation_set_paused(paused)
signal simulation_ended
signal use

var simulation_running = false
var simulation_paused = false
var selected_nodes: Array[Node]


func _enter_tree() -> void:
	if not Engine.is_editor_hint():
		return

	EditorInterface.get_selection().selection_changed.connect(_on_selection_changed)

	var editor_settings := EditorInterface.get_editor_settings()

	if not editor_settings.get_shortcut("Open Industry Project/Use"):
		var alert_shortcut := Shortcut.new()
		var key_stroke := InputEventKey.new()
		key_stroke.keycode = KEY_C
		alert_shortcut.events.append(key_stroke)
		editor_settings.add_shortcut("Open Industry Project/Use", alert_shortcut)

	# Add shortcut for conveyor snapping
	if not editor_settings.get_shortcut("Open Industry Project/Snap Conveyor"):
		var snap_shortcut := Shortcut.new()
		var snap_key_stroke := InputEventKey.new()
		snap_key_stroke.keycode = KEY_C
		snap_key_stroke.ctrl_pressed = true
		snap_key_stroke.shift_pressed = true
		snap_shortcut.events.append(snap_key_stroke)
		editor_settings.add_shortcut("Open Industry Project/Snap Conveyor", snap_shortcut)


func _ready() -> void:
	if is_instance_valid(owner):
		await owner.ready

		EditorInterface.set_main_screen_editor("3D")
		EditorInterface.open_scene_from_path("res://Main/Main.tscn")

	get_tree().paused = false


func _process(delta: float) -> void:
	_select_nodes()


func _input(event: InputEvent) -> void:
	if not Engine.is_editor_hint():
		return

	var editor_settings := EditorInterface.get_editor_settings()
	
	# Handle Use shortcut
	if editor_settings.is_shortcut("Open Industry Project/Use", event) and event.is_pressed() and not event.is_echo():
		var selection = EditorInterface.get_selection()
		for node : Node in selection.get_selected_nodes():
			if(node.has_method("use")):
				node.call("use")
	
	# Handle Snap Conveyor shortcut
	if editor_settings.is_shortcut("Open Industry Project/Snap Conveyor", event) and event.is_pressed() and not event.is_echo():
		_snap_selected_conveyors()


func start_simulation() -> void:
	simulation_paused = false
	simulation_set_paused.emit(false)
	simulation_started.emit()
	if EditorInterface.has_method("set_simulation_started"):
		EditorInterface.call("set_simulation_started", true)


func stop_simulation() -> void:
	simulation_paused = false
	simulation_set_paused.emit(false)
	simulation_ended.emit()
	if EditorInterface.has_method("set_simulation_started"):
		EditorInterface.call("set_simulation_started", false)


func toggle_pause_simulation(pressed: bool = !simulation_paused) -> void:
	simulation_paused = pressed
	simulation_set_paused.emit(pressed)
	if simulation_paused:
		get_tree().edited_scene_root.process_mode = Node.PROCESS_MODE_DISABLED
	else:
		get_tree().edited_scene_root.process_mode = Node.PROCESS_MODE_INHERIT


func _on_selection_changed() -> void:
	selected_nodes = EditorInterface.get_selection().get_selected_nodes()
	_select_nodes()


func _select_nodes() -> void:
	if selected_nodes.size() > 0:
		for node: Node in selected_nodes:
			if(!node):
				return

			if node.has_method("selected"):
				node.call("selected")


# Conveyor Snapping Functions
func _snap_selected_conveyors() -> void:
	var selection = EditorInterface.get_selection()
	var selected_conveyors: Array[Node3D] = []
	
	# Find selected conveyors (assemblies or individual conveyors)
	for node in selection.get_selected_nodes():
		print("Checking selected node: ", node.name, " (", node.get_class(), ")")
		if _is_conveyor(node):
			selected_conveyors.append(node as Node3D)
			print("  -> Identified as conveyor!")
		else:
			print("  -> Not identified as conveyor")
	
	if selected_conveyors.is_empty():
		print("No conveyors selected for snapping")
		return
	
	print("Found ", selected_conveyors.size(), " selected conveyors")
	
	# Snap each selected conveyor to its closest neighbor
	for conveyor in selected_conveyors:
		_snap_conveyor_to_closest(conveyor)


func _is_conveyor(node: Node) -> bool:
	# Assembly types
	if node is BeltConveyorAssembly:
		return true
	if node is RollerConveyorAssembly:
		return true
	if node is CurvedBeltConveyorAssembly:
		return true
	
	# Script-based types
	var node_script = node.get_script()
	if node_script != null:
		var global_name = node_script.get_global_name()
		if global_name == "BeltSpurConveyor":
			return true
		elif global_name == "SpurConveyorAssembly":
			return true
		elif global_name == "BeltConveyor":
			return true
		elif global_name == "RollerConveyor":
			return true
		elif global_name == "CurvedBeltConveyor":
			return true
		elif global_name == "BeltConveyorArea3D":
			return true
	
	# Built-in class types
	var node_class = node.get_class()
	if node_class == "BeltConveyor":
		return true
	elif node_class == "RollerConveyor":
		return true
	elif node_class == "CurvedBeltConveyor":
		return true
	
	return false


func _snap_conveyor_to_closest(selected_conveyor: Node3D) -> void:
	var closest_conveyor: Node3D = _find_closest_conveyor(selected_conveyor)
	
	if not closest_conveyor:
		print("No other conveyors found to snap to")
		return
	
	# Calculate snap position and rotation
	var snap_transform = _calculate_snap_transform(selected_conveyor, closest_conveyor)
	
	# Apply the snap transform
	selected_conveyor.global_transform = snap_transform
	
	print("Snapped conveyor to closest neighbor")


func _find_closest_conveyor(selected_conveyor: Node3D) -> Node3D:
	var closest_conveyor: Node3D = null
	var closest_distance: float = INF
	var selected_position = selected_conveyor.global_position
	
	# Search through the scene tree for other conveyor assemblies
	var scene_root = get_tree().edited_scene_root
	if not scene_root:
		print("No scene root found!")
		return null
	
	print("Searching for conveyors in scene: ", scene_root.name)
	print("Selected conveyor position: ", selected_position)
	
	var search_result = _search_for_conveyors_recursive(scene_root, selected_conveyor, selected_position)
	
	if search_result.conveyor:
		print("Found closest conveyor: ", search_result.conveyor.name, " at distance: ", search_result.distance)
	else:
		print("No conveyors found in scene search")
	
	return search_result.conveyor if search_result.conveyor else null


func _search_for_conveyors_recursive(node: Node, selected_conveyor: Node3D, selected_position: Vector3) -> Dictionary:
	var closest_conveyor: Node3D = null
	var closest_distance: float = INF
	
	# Debug: Show all nodes being checked
	print("  Checking node: ", node.name, " (", node.get_class(), ")")
	
	# Skip the selected conveyor itself
	if node != selected_conveyor:
		# Check if this node is a conveyor (assembly or individual)
		if node is Node3D:
			print("    -> Is Node3D, checking if conveyor...")
			if _is_conveyor(node):
				var other_conveyor = node as Node3D
				var distance = selected_position.distance_to(other_conveyor.global_position)
				
				print("    -> FOUND CONVEYOR: ", node.name, " at distance: ", distance)
				
				if distance < closest_distance:
					closest_distance = distance
					closest_conveyor = other_conveyor
			else:
				print("    -> Not identified as conveyor")
		else:
			print("    -> Not a Node3D")
	else:
		print("    -> Skipping (this is the selected conveyor)")
	
	# Recursively search children
	for child in node.get_children():
		var child_result = _search_for_conveyors_recursive(child, selected_conveyor, selected_position)
		if child_result.conveyor and child_result.distance < closest_distance:
			closest_distance = child_result.distance
			closest_conveyor = child_result.conveyor
	
	return {"conveyor": closest_conveyor, "distance": closest_distance}


func _calculate_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
	var target_transform = target_conveyor.global_transform
	var selected_transform = selected_conveyor.global_transform
	var selected_size = _get_conveyor_size(selected_conveyor)
	var target_size = _get_conveyor_size(target_conveyor)
	
	# Calculate all four edge positions of the target conveyor
	var target_front_edge = target_transform.origin + target_transform.basis.x * (target_size.x / 2.0)
	var target_back_edge = target_transform.origin - target_transform.basis.x * (target_size.x / 2.0)
	var target_left_edge = target_transform.origin - target_transform.basis.z * (target_size.z / 2.0)
	var target_right_edge = target_transform.origin + target_transform.basis.z * (target_size.z / 2.0)
	
	# Find which edge is closest to the selected conveyor
	var selected_position = selected_transform.origin
	var distance_to_front = selected_position.distance_to(target_front_edge)
	var distance_to_back = selected_position.distance_to(target_back_edge)
	var distance_to_left = selected_position.distance_to(target_left_edge)
	var distance_to_right = selected_position.distance_to(target_right_edge)
	
	# Find the minimum distance and corresponding edge
	var min_distance = min(distance_to_front, min(distance_to_back, min(distance_to_left, distance_to_right)))
	
	var snap_transform = Transform3D()
	
	if min_distance == distance_to_front:
		# Snap to front edge (end-to-end connection)
		print("Snapping to front edge of target conveyor")
		var connection_position = target_front_edge + target_transform.basis.x * (selected_size.x / 2.0)
		snap_transform.basis = target_transform.basis
		snap_transform.origin = connection_position
		
	elif min_distance == distance_to_back:
		# Snap to back edge (end-to-end connection, flipped)
		print("Snapping to back edge of target conveyor")
		var connection_position = target_back_edge - target_transform.basis.x * (selected_size.x / 2.0)
		snap_transform.basis = target_transform.basis
		snap_transform.basis.x = -snap_transform.basis.x  # Flip X-axis
		snap_transform.basis.z = -snap_transform.basis.z  # Flip Z-axis
		snap_transform.origin = connection_position
		
	elif min_distance == distance_to_left:
		# Snap to left side (perpendicular connection)
		print("Snapping to left side of target conveyor (perpendicular)")
		var connection_position = target_left_edge - target_transform.basis.z * (selected_size.x / 2.0)
		# Rotate 90 degrees clockwise around Y-axis relative to target
		snap_transform.basis.x = target_transform.basis.z
		snap_transform.basis.y = target_transform.basis.y
		snap_transform.basis.z = -target_transform.basis.x
		snap_transform.origin = connection_position
		
	else:  # min_distance == distance_to_right
		# Snap to right side (perpendicular connection)
		print("Snapping to right side of target conveyor (perpendicular)")
		var connection_position = target_right_edge + target_transform.basis.z * (selected_size.x / 2.0)
		# Rotate 90 degrees counter-clockwise around Y-axis relative to target
		snap_transform.basis.x = -target_transform.basis.z
		snap_transform.basis.y = target_transform.basis.y
		snap_transform.basis.z = target_transform.basis.x
		snap_transform.origin = connection_position
	
	return snap_transform


func _get_conveyor_size(conveyor: Node3D) -> Vector3:
	# Try to get the size property from the conveyor
	if "size" in conveyor:
		return conveyor.size
	
	# Fallback to default size
	return Vector3(4.0, 0.5, 1.524)
