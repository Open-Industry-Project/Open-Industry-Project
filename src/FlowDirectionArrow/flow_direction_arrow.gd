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


static func create_curved(inner_radius: float, conveyor_width: float, belt_height: float, angle_degrees: float) -> Node3D:
	var arrow := Node3D.new()
	arrow.name = "FlowDirectionArrow"

	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.0, 1.0, 0.0, 0.9)
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.no_depth_test = true

	var center_radius := inner_radius + conveyor_width / 2.0
	var angle_rad := deg_to_rad(angle_degrees)
	var shaft_radius := 0.05
	var head_radius := 0.15
	var head_height := 0.25

	# Build curved shaft as a series of small cylinders along the arc
	var arc_length := center_radius * angle_rad
	var segment_count := maxi(8, int(angle_degrees / 5.0))
	var shaft_arc := angle_rad * 0.8
	var shaft_start := angle_rad * 0.1
	var shaft_segment_angle := shaft_arc / segment_count

	for i in segment_count:
		var a0 := shaft_start + i * shaft_segment_angle
		var a1 := shaft_start + (i + 1) * shaft_segment_angle
		var mid_a := (a0 + a1) / 2.0

		var seg_length := center_radius * shaft_segment_angle
		var seg := MeshInstance3D.new()
		var seg_mesh := CylinderMesh.new()
		seg_mesh.top_radius = shaft_radius
		seg_mesh.bottom_radius = shaft_radius
		seg_mesh.height = seg_length
		seg_mesh.material = mat
		seg.mesh = seg_mesh

		# Position at midpoint of arc segment; arc is in XZ plane, angle from +Z axis
		seg.position = Vector3(-sin(mid_a) * center_radius, 0.0, cos(mid_a) * center_radius)
		# Rotate cylinder (Y-axis aligned) to lie tangent to the arc
		seg.rotation.y = -mid_a
		seg.rotation.z = PI / 2.0
		arrow.add_child(seg)

	# Arrowhead at the end of the arc (at angle angle_rad * 0.9)
	var head_angle := shaft_start + shaft_arc
	var head := MeshInstance3D.new()
	var head_mesh := CylinderMesh.new()
	head_mesh.top_radius = 0.0
	head_mesh.bottom_radius = head_radius
	head_mesh.height = head_height
	head_mesh.material = mat
	head.mesh = head_mesh

	head.position = Vector3(-sin(head_angle) * center_radius, 0.0, cos(head_angle) * center_radius)
	# Cone points tangent to arc (in the direction of increasing angle)
	head.rotation.y = -head_angle
	head.rotation.z = PI / 2.0
	arrow.add_child(head)

	arrow.position.y = belt_height / 2.0 + 0.2

	return arrow
