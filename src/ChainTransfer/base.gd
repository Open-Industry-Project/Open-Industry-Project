@tool
extends Node3D
class_name ChainTransferBase

@export var active: bool = false:
	set(value):
		active = value
		if(active):
			_up()
		else:
			_down()

var speed: float = 0.0

var container_body: StaticBody3D
var chain_base: Node3D
var container: Node3D
var chain: Node3D

var inactive_pos: float = 0.0
var active_pos: float = 0.095

var sb: StaticBody3D
var sb_active_position: Vector3 = Vector3.ZERO
var sb_inactive_position: Vector3 = Vector3.ZERO

var running: bool = false

var chain_base_length: float = 2.0   
var chain_scale: int = 32           
var chain_end_scale: int = 6  

var chain_mesh: MeshInstance3D
var chain_end_l_mesh: MeshInstance3D
var chain_end_r_mesh: MeshInstance3D

var chain_material: ShaderMaterial
var chain_end_l_material: ShaderMaterial
var chain_end_r_material: ShaderMaterial

var chain_position: float = 0.0
var chain_end_position: float = 0.0

func init_mesh(path: String) -> Array:
	var m = get_node(path) as MeshInstance3D
	m.mesh = m.mesh.duplicate()
	var mat = m.mesh.surface_get_material(0).duplicate() as ShaderMaterial
	m.mesh.surface_set_material(0, mat)
	return [m, mat]

func set_chain_position(mat: ShaderMaterial, pos: float) -> void:
	if mat:
		mat.set_shader_parameter("ChainPosition", pos)

func ensure_valid_node_references() -> void:
	if sb:
		return
	container_body = get_node("ContainerBody") as StaticBody3D
	chain_base = get_node("Base") as Node3D
	container = get_node("Container") as Node3D
	chain = get_node("Chain") as Node3D
	sb = get_node("Chain/StaticBody3D") as StaticBody3D

func scale_children(nodes_container: Node3D) -> void:
	if owner == null:
		return
	for child in nodes_container.get_children():
		# If the container is "Chain" and the child is a StaticBody3D, skip scaling.
		if nodes_container.name == "Chain" and child is StaticBody3D:
			continue
		if child is Node3D:
			child.scale = Vector3(1 / owner.scale.x, 1, 1)

func _ready() -> void:
	ensure_valid_node_references()
	
	var result = init_mesh("Chain")
	chain_mesh = result[0]
	chain_material = result[1]
	
	result = init_mesh("Chain/ChainL")
	chain_end_l_mesh = result[0]
	chain_end_l_material = result[1]
	
	result = init_mesh("Chain/ChainR")
	chain_end_r_mesh = result[0]
	chain_end_r_material = result[1]
	
	chain_position = 0.0
	chain_end_position = 0.0
	set_chain_position(chain_material, 0.0)
	set_chain_position(chain_end_l_material, 0.0)
	set_chain_position(chain_end_r_material, 0.0)
	
	owner = get_parent().get_parent()  # Assumes owner's type is ChainTransfer

func _physics_process(delta: float) -> void:
	if running:
		var local_left = sb.global_transform.basis.x.normalized()
		var velocity = local_left * speed
		sb.constant_linear_velocity = velocity
		sb.position = sb_active_position
		sb.rotation = Vector3.ZERO
		sb.scale = Vector3.ONE
		
		if chain_material and owner:
			var chain_links: int = int(round(owner.scale.x * chain_scale))
			var chain_meters: float = owner.scale.x * chain_base_length
			var chain_links_per_meter: float = chain_links / chain_meters
			if not SimulationEvents.simulation_paused:
				chain_position += speed / chain_meters * delta
			chain_position = fmod((fmod(chain_position,1) + 1.0),1)
			chain_end_position += speed * chain_links_per_meter / chain_end_scale * delta
			chain_end_position = fmod((fmod(chain_end_position,1) + 1.0),1)
			set_chain_position(chain_material, chain_position)
			set_chain_position(chain_end_l_material, chain_end_position)
			set_chain_position(chain_end_r_material, chain_end_position)
	
	if chain_material and owner:
		chain_material.set_shader_parameter("Scale", owner.scale.x * chain_scale)
	
	scale_children(chain_base)
	scale_children(container)
	scale_children(chain)

func turn_on() -> void:
	running = true

func turn_off() -> void:
	running = false
	chain_position = 0.0
	chain_end_position = 0.0
	set_chain_position(chain_material, 0.0)
	set_chain_position(chain_end_l_material, 0.0)
	set_chain_position(chain_end_r_material, 0.0)
	sb.position = sb_inactive_position
	sb.rotation = Vector3.ZERO
	sb.constant_linear_velocity = Vector3.ZERO

func _up() -> void:
	ensure_valid_node_references()
	if is_inside_tree():
		var tween = create_tween().set_parallel()
		tween.tween_property(container_body, "position", Vector3(container_body.position.x, active_pos, container_body.position.z), 0.15)
		tween.tween_property(container, "position", Vector3(container.position.x, active_pos, container.position.z), 0.15)
		tween.tween_property(chain, "position", Vector3(chain.position.x, active_pos, chain.position.z), 0.15)
	else:
		container_body.position = Vector3(container_body.position.x, active_pos, container_body.position.z)
		container.position = Vector3(container.position.x, active_pos, container.position.z)
		chain.position = Vector3(chain.position.x, active_pos, chain.position.z)

func _down() -> void:
	ensure_valid_node_references()
	if is_inside_tree():
		var tween = create_tween().set_parallel()
		tween.tween_property(container_body, "position", Vector3(container_body.position.x, inactive_pos, container_body.position.z), 0.15)
		tween.tween_property(container, "position", Vector3(container.position.x, inactive_pos, container.position.z), 0.15)
		tween.tween_property(chain, "position", Vector3(chain.position.x, inactive_pos, chain.position.z), 0.15)
	else:
		container_body.position = Vector3(container_body.position.x, inactive_pos, container_body.position.z)
		container.position = Vector3(container.position.x, inactive_pos, container.position.z)
		chain.position = Vector3(chain.position.x, inactive_pos, chain.position.z)
