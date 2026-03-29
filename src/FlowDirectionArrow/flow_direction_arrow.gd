@tool
class_name FlowDirectionArrow


static func create(conveyor_size: Vector3) -> Node3D:
	var arrow := Node3D.new()
	arrow.name = "FlowDirectionArrow"

	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.0, 1.0, 0.0, 0.9)
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.no_depth_test = true

	var arrow_length := conveyor_size.x * 0.6
	var shaft_radius := 0.05
	var head_radius := 0.15
	var head_height := 0.25

	# Shaft (cylinder rotated to lie along X)
	var shaft := MeshInstance3D.new()
	var shaft_mesh := CylinderMesh.new()
	shaft_mesh.top_radius = shaft_radius
	shaft_mesh.bottom_radius = shaft_radius
	shaft_mesh.height = arrow_length
	shaft_mesh.material = mat
	shaft.mesh = shaft_mesh
	shaft.rotation.z = PI / 2.0
	arrow.add_child(shaft)

	# Arrowhead (cone pointing in +X)
	var head := MeshInstance3D.new()
	var head_mesh := CylinderMesh.new()
	head_mesh.top_radius = 0.0
	head_mesh.bottom_radius = head_radius
	head_mesh.height = head_height
	head_mesh.material = mat
	head.mesh = head_mesh
	head.rotation.z = -PI / 2.0
	head.position.x = arrow_length / 2.0 + head_height / 2.0
	arrow.add_child(head)

	arrow.position.y = conveyor_size.y / 2.0 + 0.2

	return arrow
