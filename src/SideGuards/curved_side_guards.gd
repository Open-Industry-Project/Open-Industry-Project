@tool
class_name CurvedSideGuards
extends MeshInstance3D

var shader_material: ShaderMaterial = null

func _init() -> void:
	set_notify_local_transform(true)

func _ready() -> void:
	# Duplicate the mesh and its material.
	self.mesh = self.mesh.duplicate()
	shader_material = self.mesh.surface_get_material(0).duplicate() as ShaderMaterial
	self.mesh.surface_set_material(0, shader_material)
	_on_scale_changed()

func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		_on_scale_changed()

func _on_scale_changed() -> void:
	var new_scale: Vector3 = Vector3(scale.x, 1, scale.x)
	if scale != new_scale:
		set_notify_local_transform(false)
		scale = new_scale
		set_notify_local_transform(true)
	if scale.x > 0.5:
		if shader_material:
			shader_material.set_shader_parameter("Scale", scale.x)
