@tool
extends Node3D

var ray_marker: Marker3D
var ray_mesh: MeshInstance3D
var cylinder_mesh: CylinderMesh
var ray_material: StandardMaterial3D

@export var max_range: float = 6.0
@export var show_beam: bool :
	set(value): 
		show_beam = value
		if(ray_marker):
			ray_marker.visible = value;
	
@export var beam_blocked_color: Color = Color(1, 1, 1)
@export var beam_scan_color: Color = Color(1, 1, 1)
@export var blocked: bool = false

func _validate_property(property: Dictionary):
	if property.name == "blocked":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_READ_ONLY

func _ready() -> void:
	ray_marker = $RayMarker
	ray_mesh = $RayMarker/MeshInstance3D
	cylinder_mesh = ray_mesh.mesh.duplicate() as CylinderMesh
	ray_mesh.mesh = cylinder_mesh
	ray_material = cylinder_mesh.material.duplicate() as StandardMaterial3D
	cylinder_mesh.material = ray_material
	ray_marker.visible = show_beam

func _enter_tree() -> void:
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)

func _exit_tree() -> void:
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)

func _physics_process(delta: float) -> void:
	var space_state = get_world_3d().direct_space_state
	var start_pos = ray_marker.global_transform.origin
	var end_pos = start_pos + global_transform.basis.z * max_range
	var query = PhysicsRayQueryParameters3D.create(start_pos, end_pos)
	query.collision_mask = 8
	var result = space_state.intersect_ray(query)
	
	if result.size() > 0:
		blocked = true
		var result_distance = ray_marker.global_transform.origin.distance_to(result["position"])
		if cylinder_mesh.height != result_distance:
				cylinder_mesh.height = result_distance
		if ray_material.albedo_color != beam_blocked_color:
				ray_material.albedo_color = beam_blocked_color
	else:
		blocked = false
		if cylinder_mesh.height != max_range:
				cylinder_mesh.height = max_range
		if ray_material.albedo_color != beam_scan_color:
				ray_material.albedo_color = beam_scan_color
	
	ray_mesh.position = Vector3(0, 0, cylinder_mesh.height * 0.5)

func _on_simulation_ended() -> void:
	cylinder_mesh.height = max_range
	ray_material.albedo_color = beam_scan_color
	ray_mesh.position = Vector3(0, 0, cylinder_mesh.height * 0.5)
