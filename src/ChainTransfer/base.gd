@tool
class_name ChainTransferBase
extends Node3D

@export var active: bool = false:
	set(value):
		active = value
		if active:
			_up()
		else:
			_down()

var speed: float = 0.0
var running: bool = false
var _inactive_pos: float = 0.0
var _active_pos: float = 0.095
var _sb_active_position: Vector3 = Vector3.ZERO
var _sb_inactive_position: Vector3 = Vector3.ZERO
var _chain_base_length: float = 2.0
var _chain_scale: int = 32
var _chain_end_scale: int = 6
var _chain_mesh: MeshInstance3D
var _chain_end_l_mesh: MeshInstance3D
var _chain_end_r_mesh: MeshInstance3D
var _chain_material: ShaderMaterial
var _chain_end_l_material: ShaderMaterial
var _chain_end_r_material: ShaderMaterial
var _chain_position: float = 0.0
var _chain_end_position: float = 0.0

@onready var _container_body: StaticBody3D = get_node("ContainerBody")
@onready var _chain_base: Node3D = get_node("Base")
@onready var _container: Node3D = get_node("Container")
@onready var _chain: Node3D = get_node("Chain")
@onready var _sb: StaticBody3D = get_node("Chain/StaticBody3D")

func _ready() -> void:
	var result := _init_mesh("Chain")
	_chain_mesh = result[0]
	_chain_material = result[1]

	result = _init_mesh("Chain/ChainL")
	_chain_end_l_mesh = result[0]
	_chain_end_l_material = result[1]

	result = _init_mesh("Chain/ChainR")
	_chain_end_r_mesh = result[0]
	_chain_end_r_material = result[1]

	_chain_position = 0.0
	_chain_end_position = 0.0
	_set_chain_position(_chain_material, 0.0)
	_set_chain_position(_chain_end_l_material, 0.0)
	_set_chain_position(_chain_end_r_material, 0.0)

	owner = get_parent().get_parent()  # Assumes owner's type is ChainTransfer

func _physics_process(delta: float) -> void:
	if running:
		var local_left := _sb.global_transform.basis.x.normalized()
		var velocity := local_left * speed
		_sb.constant_linear_velocity = velocity
		_sb.position = _sb_active_position
		_sb.rotation = Vector3.ZERO
		_sb.scale = Vector3.ONE

		if _chain_material and owner:
			var chain_links: int = int(round(owner.scale.x * _chain_scale))
			var chain_meters: float = owner.scale.x * _chain_base_length
			var chain_links_per_meter: float = chain_links / chain_meters
			if not SimulationEvents.simulation_paused:
				_chain_position += speed / chain_meters * delta
			_chain_position = fmod((fmod(_chain_position, 1) + 1.0), 1)
			_chain_end_position += speed * chain_links_per_meter / _chain_end_scale * delta
			_chain_end_position = fmod((fmod(_chain_end_position, 1) + 1.0), 1)
			_set_chain_position(_chain_material, _chain_position)
			_set_chain_position(_chain_end_l_material, _chain_end_position)
			_set_chain_position(_chain_end_r_material, _chain_end_position)

	if _chain_material and owner:
		_chain_material.set_shader_parameter("Scale", owner.scale.x * _chain_scale)

	_scale_children(_chain_base)
	_scale_children(_container)
	_scale_children(_chain)

func turn_on() -> void:
	running = true

func turn_off() -> void:
	running = false
	_chain_position = 0.0
	_chain_end_position = 0.0
	_set_chain_position(_chain_material, 0.0)
	_set_chain_position(_chain_end_l_material, 0.0)
	_set_chain_position(_chain_end_r_material, 0.0)
	_sb.position = _sb_inactive_position
	_sb.rotation = Vector3.ZERO
	_sb.constant_linear_velocity = Vector3.ZERO

func _init_mesh(path: String) -> Array:
	var m := get_node(path) as MeshInstance3D
	var mat := m.mesh.surface_get_material(0).duplicate() as ShaderMaterial
	m.set_surface_override_material(0, mat)
	return [m, mat]

func _set_chain_position(mat: ShaderMaterial, pos: float) -> void:
	if mat:
		mat.set_shader_parameter("ChainPosition", pos)

func _scale_children(nodes_container: Node3D) -> void:
	if owner == null:
		return
	
	for child in nodes_container.get_children():
		# If the container is "Chain" and the child is a StaticBody3D, skip scaling.
		if nodes_container.name == "Chain" and child is StaticBody3D:
			continue
		if child is Node3D:
			child.scale = Vector3(1 / owner.scale.x, 1, 1)

func _up() -> void:
	if is_inside_tree():
		var tween := create_tween().set_parallel()
		tween.tween_property(_container_body, "position", Vector3(_container_body.position.x, _active_pos, _container_body.position.z), 0.15)
		tween.tween_property(_container, "position", Vector3(_container.position.x, _active_pos, _container.position.z), 0.15)
		tween.tween_property(_chain, "position", Vector3(_chain.position.x, _active_pos, _chain.position.z), 0.15)
	else:
		_container_body.position = Vector3(_container_body.position.x, _active_pos, _container_body.position.z)
		_container.position = Vector3(_container.position.x, _active_pos, _container.position.z)
		_chain.position = Vector3(_chain.position.x, _active_pos, _chain.position.z)

func _down() -> void:
	if is_inside_tree():
		var tween := create_tween().set_parallel()
		tween.tween_property(_container_body, "position", Vector3(_container_body.position.x, _inactive_pos, _container_body.position.z), 0.15)
		tween.tween_property(_container, "position", Vector3(_container.position.x, _inactive_pos, _container.position.z), 0.15)
		tween.tween_property(_chain, "position", Vector3(_chain.position.x, _inactive_pos, _chain.position.z), 0.15)
	else:
		_container_body.position = Vector3(_container_body.position.x, _inactive_pos, _container_body.position.z)
		_container.position = Vector3(_container.position.x, _inactive_pos, _container.position.z)
		_chain.position = Vector3(_chain.position.x, _inactive_pos, _chain.position.z)
