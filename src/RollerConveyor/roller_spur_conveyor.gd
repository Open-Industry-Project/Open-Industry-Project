@tool
class_name RollerSpurConveyor
extends ResizableNode3D

## Diverging roller-spur conveyor — rollers clipped to a splayed footprint.

const _MIN_GUARD_LEN: float = 0.05
const _LEG_TAIL_NAME := "Leg_Tail"
const _LEG_HEAD_NAME := "Leg_Head"
const _LEG_MIDDLE_PREFIX := "Leg_Middle_"


@export_custom(PROPERTY_HINT_NONE, "suffix:m") var length: float:
	set(value):
		size = Vector3(value, size.y, size.z)
	get:
		return size.x

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var width: float:
	set(value):
		size = Vector3(size.x, size.y, value)
	get:
		return size.z

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var depth: float:
	set(value):
		size = Vector3(size.x, value, size.z)
	get:
		return size.y

## Splay angle of the downstream (+X) end. Positive splays outward.
@export_range(-70, 70, 1, "radians_as_degrees") var angle_downstream: float = 0.0:
	set(value):
		if value == angle_downstream:
			return
		angle_downstream = value
		_request_rebuild()

## Splay angle of the upstream (-X) end. Positive splays outward.
@export_range(-70, 70, 1, "radians_as_degrees") var angle_upstream: float = 0.0:
	set(value):
		if value == angle_upstream:
			return
		angle_upstream = value
		_request_rebuild()

@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var speed: float = 1.0:
	set(value):
		if value == speed:
			return
		speed = value
		_update_conveyor_velocity()
		if _running_tag.is_ready():
			_running_tag.write_bit(value != 0.0)


@export_group("Frame & Side Guards")
@export var frame_rails_enabled: bool = true:
	set(value):
		if value == frame_rails_enabled:
			return
		frame_rails_enabled = value
		_request_rebuild()

@export var left_side_guards_enabled: bool = true:
	set(value):
		if value == left_side_guards_enabled:
			return
		left_side_guards_enabled = value
		_request_side_guard_rebuild()

@export var right_side_guards_enabled: bool = true:
	set(value):
		if value == right_side_guards_enabled:
			return
		right_side_guards_enabled = value
		_request_side_guard_rebuild()

## Openings in conveyor-local X (origin-centered). arc-length == X (single-segment).
@export_storage var side_guard_openings: Array[SideGuardOpening] = []:
	set(value):
		side_guard_openings = value
		_request_side_guard_rebuild()

## Per-side end overrides for frame and side guard. Snap uses this to extend the rails
## and guards up to the target's wall plane. Keys: [code]"left_front"[/code],
## [code]"left_back"[/code], [code]"right_front"[/code], [code]"right_back"[/code].
@export_storage var side_guard_snap_extents: Dictionary = {}:
	set(value):
		side_guard_snap_extents = value
		_request_rebuild()


@export_group("Legs")
@export var legs_enabled: bool = true:
	set(value):
		if value == legs_enabled:
			return
		legs_enabled = value
		_request_legs_refresh()

@export var floor_plane: Plane = Plane(Vector3.UP, -2.0):
	set(value):
		if floor_plane.is_equal_approx(value):
			return
		floor_plane = value
		_request_legs_refresh()

@export var leg_model_scene: PackedScene = preload("res://parts/ConveyorLeg.tscn"):
	set(value):
		leg_model_scene = value
		_request_legs_refresh()

@export_subgroup("Tail End", "tail_end")
@export var tail_end_leg_enabled: bool = true:
	set(value):
		if value == tail_end_leg_enabled:
			return
		tail_end_leg_enabled = value
		_request_legs_refresh()

@export_range(0.0, 1.0, 0.01, "or_greater", "suffix:m") var tail_end_attachment_offset: float = 0.45:
	set(value):
		if value == tail_end_attachment_offset:
			return
		tail_end_attachment_offset = maxf(0.0, value)
		_request_legs_refresh()

@export_range(0.0, 5.0, 0.01, "or_greater", "suffix:m") var tail_end_leg_clearance: float = 0.5:
	set(value):
		if value == tail_end_leg_clearance:
			return
		tail_end_leg_clearance = maxf(0.0, value)
		_request_legs_refresh()

@export_subgroup("Head End", "head_end")
@export var head_end_leg_enabled: bool = false:
	set(value):
		if value == head_end_leg_enabled:
			return
		head_end_leg_enabled = value
		_request_legs_refresh()

@export_range(0.0, 1.0, 0.01, "or_greater", "suffix:m") var head_end_attachment_offset: float = 0.45:
	set(value):
		if value == head_end_attachment_offset:
			return
		head_end_attachment_offset = maxf(0.0, value)
		_request_legs_refresh()

@export_range(0.0, 5.0, 0.01, "or_greater", "suffix:m") var head_end_leg_clearance: float = 0.5:
	set(value):
		if value == head_end_leg_clearance:
			return
		head_end_leg_clearance = maxf(0.0, value)
		_request_legs_refresh()

@export_subgroup("Middle Legs", "middle_legs")
@export var middle_legs_enabled: bool = false:
	set(value):
		if value == middle_legs_enabled:
			return
		middle_legs_enabled = value
		_request_legs_refresh()

@export_range(0.5, 10.0, 0.05, "or_greater", "suffix:m") var middle_legs_spacing: float = 2.0:
	set(value):
		var clamped: float = maxf(0.5, value)
		if clamped == middle_legs_spacing:
			return
		middle_legs_spacing = clamped
		_request_legs_refresh()

@export_subgroup("Leg Exclusion Zone", "exclusion_")
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var exclusion_start: float = 0.0:
	set(value):
		if value == exclusion_start:
			return
		exclusion_start = value
		_request_legs_refresh()

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var exclusion_end: float = 0.0:
	set(value):
		if value == exclusion_end:
			return
		exclusion_end = value
		_request_legs_refresh()


@export_category("Communications")
@export var enable_comms: bool = false
@export var speed_tag_group_name: String
@export_custom(0, "tag_group_enum") var speed_tag_groups: String:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
@export var speed_tag_name: String = ""
@export var running_tag_group_name: String
@export_custom(0, "tag_group_enum") var running_tag_groups: String:
	set(value):
		running_tag_group_name = value
		running_tag_groups = value
@export var running_tag_name: String = ""


var running: bool = false:
	set(value):
		running = value
		set_physics_process(running)


var _rollers: Rollers
var _ends: Node3D
var _simple_conveyor_shape: StaticBody3D
var _frame_left: MeshInstance3D
var _frame_right: MeshInstance3D
var _side_guards: Array[SideGuard] = []
var _legs: Array[Node3D] = []
var _flow_arrow: Node3D
var _roller_material: BaseMaterial3D
var _frame_material: ShaderMaterial
var _rebuild_pending: bool = false
var _side_guard_rebuild_pending: bool = false
var _legs_refresh_pending: bool = false
var _speed_tag := OIPCommsTag.new()
var _running_tag := OIPCommsTag.new()


func _init() -> void:
	super._init()
	size_default = Vector3(2, 0.5, 1.524)
	if size == Vector3.ZERO:
		size = size_default


func _validate_property(property: Dictionary) -> void:
	var prop_name: String = property["name"]
	if prop_name in ["length", "width", "depth"]:
		property["usage"] = PROPERTY_USAGE_EDITOR
		return
	if prop_name == "size":
		property["usage"] = PROPERTY_USAGE_STORAGE
		return
	if OIPCommsSetup.validate_tag_property(property, "speed_tag_group_name", "speed_tag_groups", "speed_tag_name"):
		return
	OIPCommsSetup.validate_tag_property(property, "running_tag_group_name", "running_tag_groups", "running_tag_name")


func _get_constrained_size(new_size: Vector3) -> Vector3:
	# Depth is fixed by roller geometry.
	return Vector3(new_size.x, size_default.y, new_size.z)


func _enter_tree() -> void:
	super._enter_tree()
	speed_tag_group_name = OIPCommsSetup.default_tag_group(speed_tag_group_name)
	running_tag_group_name = OIPCommsSetup.default_tag_group(running_tag_group_name)
	if Engine.is_editor_hint():
		if not EditorInterface.simulation_started.is_connected(_on_simulation_started):
			EditorInterface.simulation_started.connect(_on_simulation_started)
		if not EditorInterface.simulation_stopped.is_connected(_on_simulation_ended):
			EditorInterface.simulation_stopped.connect(_on_simulation_ended)
		running = EditorInterface.is_simulation_running()
	OIPCommsSetup.connect_comms(self, _tag_group_initialized, _tag_group_polled)


func _exit_tree() -> void:
	if is_instance_valid(_flow_arrow):
		FlowDirectionArrow.unregister(_flow_arrow)
	if Engine.is_editor_hint():
		if EditorInterface.simulation_started.is_connected(_on_simulation_started):
			EditorInterface.simulation_started.disconnect(_on_simulation_started)
		if EditorInterface.simulation_stopped.is_connected(_on_simulation_ended):
			EditorInterface.simulation_stopped.disconnect(_on_simulation_ended)
	OIPCommsSetup.disconnect_comms(self, _tag_group_initialized, _tag_group_polled)
	super._exit_tree()


func _ready() -> void:
	_clear_stale_snap_metas()
	_reset_preview_holder_transform()
	_ensure_internal_nodes()
	SideGuardOpening.claim_unique(side_guard_openings, get_instance_id())
	_rebuild()
	_bind_snap_meta_now()


func _reset_preview_holder_transform() -> void:
	if not has_meta("is_preview"):
		return
	var holder := get_parent() as Node3D
	if holder == null:
		return
	holder.transform = Transform3D.IDENTITY


func _notification(what: int) -> void:
	super(what)
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		_request_legs_refresh()


func _on_size_changed() -> void:
	_request_rebuild()


func _get_custom_preview_node() -> Node3D:
	# GEN_EDIT_STATE_DISABLED: preview-holder transform leaks with GEN_EDIT_STATE_INSTANCE.
	var preview_scene := load("res://parts/RollerSpurConveyor.tscn") as PackedScene
	var preview_node := preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D
	preview_node.set_meta("is_preview", true)
	_disable_collisions_recursive(preview_node)
	return preview_node


static func _disable_collisions_recursive(node: Node) -> void:
	if node is CollisionShape3D:
		(node as CollisionShape3D).disabled = true
	if node is CollisionObject3D:
		var co: CollisionObject3D = node
		co.collision_layer = 0
		co.collision_mask = 0
	for child in node.get_children(true):
		_disable_collisions_recursive(child)


func _clear_stale_snap_metas() -> void:
	if not Engine.is_editor_hint():
		return
	var edited_root := EditorInterface.get_edited_scene_root()
	if edited_root != null and self != edited_root and not edited_root.is_ancestor_of(self):
		return
	const STALE: PackedStringArray = [
		"_snap_transform",
		"_snap_baseline_reverse",
		"_snap_baseline_floor_plane",
		"_snap_baseline_legs_xform",
		"_snap_flip_decision",
	]
	for key: String in STALE:
		if has_meta(key):
			remove_meta(key)


func _bind_snap_meta_now() -> void:
	if not Engine.is_editor_hint() or ConveyorLiveSnap.instance == null:
		return
	var edited_root := EditorInterface.get_edited_scene_root()
	if edited_root == null:
		return
	if self != edited_root and not edited_root.is_ancestor_of(self):
		return
	ConveyorLiveSnap.instance.bind_snap_meta(self)


func _collision_repositioned(collision_point: Vector3, collision_normal: Vector3) -> void:
	if collision_normal == Vector3.ZERO:
		return
	var new_plane: Plane = Plane(collision_normal, collision_point)
	if floor_plane.is_equal_approx(new_plane):
		return
	floor_plane = new_plane


func _collision_repositioned_save() -> Variant:
	return floor_plane


func _collision_repositioned_undo(saved: Variant) -> void:
	if saved is Plane:
		floor_plane = saved


func _ensure_internal_nodes() -> void:
	if _roller_material == null:
		_roller_material = load("res://assets/3DModels/Materials/Metall2.tres").duplicate(true) as BaseMaterial3D
	if _frame_material == null:
		_frame_material = ConveyorFrameMesh.create_material()
	_ensure_simple_collision()
	_ensure_rollers_node()
	_ensure_ends_node()


func _ensure_simple_collision() -> void:
	if not is_instance_valid(_simple_conveyor_shape):
		_simple_conveyor_shape = get_node_or_null("SimpleConveyorShape") as StaticBody3D
		if not is_instance_valid(_simple_conveyor_shape):
			_simple_conveyor_shape = StaticBody3D.new()
			_simple_conveyor_shape.name = "SimpleConveyorShape"
			add_child(_simple_conveyor_shape, false, Node.INTERNAL_MODE_FRONT)
			_simple_conveyor_shape.owner = self
			var phys := PhysicsMaterial.new()
			phys.friction = 0.8
			phys.rough = true
			_simple_conveyor_shape.physics_material_override = phys
		var cs: CollisionShape3D = _simple_conveyor_shape.get_node_or_null("CollisionShape3D") as CollisionShape3D
		if cs == null:
			cs = CollisionShape3D.new()
			cs.name = "CollisionShape3D"
			_simple_conveyor_shape.add_child(cs)
			cs.owner = self


func _ensure_rollers_node() -> void:
	if not is_instance_valid(_rollers):
		_rollers = get_node_or_null("Rollers") as Rollers
		if not is_instance_valid(_rollers):
			_rollers = Rollers.new()
			_rollers.name = "Rollers"
			_rollers.roller_scene = load("res://src/RollerConveyor/Roller.tscn") as PackedScene
			add_child(_rollers, false, Node.INTERNAL_MODE_FRONT)
			_rollers.owner = self


func _ensure_ends_node() -> void:
	if not is_instance_valid(_ends):
		_ends = get_node_or_null("Ends") as Node3D
		if not is_instance_valid(_ends):
			_ends = Node3D.new()
			_ends.name = "Ends"
			add_child(_ends, false, Node.INTERNAL_MODE_FRONT)
			_ends.owner = self
		var end_scene: PackedScene = load("res://src/RollerConveyor/RollerConveyorEnd.tscn") as PackedScene
		for n: String in ["RollerConveyorEnd", "RollerConveyorEnd2"]:
			var existing := _ends.get_node_or_null(n)
			if existing == null and end_scene != null:
				var end := end_scene.instantiate() as Node3D
				end.name = n
				if n == "RollerConveyorEnd2" and "flipped" in end:
					end.flipped = true
				_ends.add_child(end)


func _request_rebuild() -> void:
	if not is_inside_tree() or _rebuild_pending:
		return
	_rebuild_pending = true
	call_deferred("_rebuild")


func _rebuild() -> void:
	_rebuild_pending = false
	if not is_inside_tree():
		return
	_ensure_internal_nodes()
	_rebuild_rollers()
	_rebuild_frame_rails()
	_rebuild_side_guards()
	_rebuild_legs()
	_rebuild_collision()
	_update_flow_arrow()
	_apply_spur_clipping()
	_update_conveyor_velocity()
	if Engine.is_editor_hint():
		update_gizmos()


func _rebuild_rollers() -> void:
	if _rollers == null:
		return
	_rollers.position = Vector3(-size.x / 2.0 + 0.2, RollerConveyor.ROLLERS_Y_OFFSET, 0)
	_rollers.scale = Vector3.ONE
	_rollers.set_width(size.z)
	_rollers.set_length(size.x)
	_rollers.setup_existing_rollers()
	for child in _rollers.get_children():
		if child is Roller:
			child.set_roller_override_material(_roller_material)
	if _ends != null:
		_ends.position = Vector3(0, RollerConveyor.ROLLERS_Y_OFFSET - 0.16, 0)
		var end_offset := 0.165
		var end1 := _ends.get_node_or_null("RollerConveyorEnd") as Node3D
		var end2 := _ends.get_node_or_null("RollerConveyorEnd2") as Node3D
		if end1:
			end1.position = Vector3(size.x / 2.0 - end_offset, 0, 0)
			end1.rotation_degrees = Vector3.ZERO
		if end2:
			end2.position = Vector3(-size.x / 2.0 + end_offset, 0, 0)
			end2.rotation_degrees = Vector3(0, 180, 0)


func _apply_spur_clipping() -> void:
	if _rollers == null:
		return
	for child in _rollers.get_children():
		if child is Roller:
			var x_spur: float = _rollers.position.x + child.position.x
			_apply_roller_clip(child as Roller, _get_spur_clip(x_spur))
	if _ends != null:
		for end_child in _ends.get_children():
			var end_roller: Roller = end_child.get_node_or_null("Roller") as Roller
			if end_roller:
				var x_spur: float = _ends.position.x + end_child.position.x
				_apply_roller_clip(end_roller, _get_spur_clip(x_spur))


func _get_spur_clip(x_spur: float) -> Vector3:
	var half_w := size.z / 2.0
	var z_min := -half_w
	var z_max := half_w
	if absf(angle_downstream) > 0.001:
		var z_ds := (x_spur - size.x / 2.0) / tan(angle_downstream)
		if angle_downstream > 0:
			z_min = maxf(z_min, z_ds)
		else:
			z_max = minf(z_max, z_ds)
	if absf(angle_upstream) > 0.001:
		var z_us := (x_spur + size.x / 2.0) / tan(angle_upstream)
		if angle_upstream > 0:
			z_max = minf(z_max, z_us)
		else:
			z_min = maxf(z_min, z_us)
	return Vector3(z_min, z_max, maxf(0.0, z_max - z_min))


func _apply_roller_clip(roller: Roller, clip: Vector3) -> void:
	if clip.z < 0.01:
		roller.visible = false
		return
	roller.visible = true
	roller.set_length_and_offset(clip.z, (clip.x + clip.y) / 2.0)


func _side_extents(side_z: float) -> Vector2:
	var front_x: float = size.x / 2.0 + tan(angle_downstream) * side_z
	var back_x: float = -size.x / 2.0 + tan(angle_upstream) * side_z
	var side_key: String = "left" if side_z < 0.0 else "right"
	if side_guard_snap_extents.has(side_key + "_front"):
		front_x = float(side_guard_snap_extents[side_key + "_front"])
	if side_guard_snap_extents.has(side_key + "_back"):
		back_x = float(side_guard_snap_extents[side_key + "_back"])
	return Vector2(back_x, front_x)


func clear_side_guard_snap_extents() -> void:
	if side_guard_snap_extents.is_empty():
		return
	side_guard_snap_extents = {}


func _rebuild_frame_rails() -> void:
	if not frame_rails_enabled:
		_remove_named_if_present(["FrameLeft", "FrameRight"])
		_frame_left = null
		_frame_right = null
		return
	var half_w: float = size.z * 0.5
	var wt: float = ConveyorFrameMesh.WALL_THICKNESS
	var left_extents := _side_extents(-half_w)
	var right_extents := _side_extents(half_w)
	_frame_left = _reconcile_frame_rail("FrameLeft", left_extents, false, -half_w - wt)
	_frame_right = _reconcile_frame_rail("FrameRight", right_extents, true, half_w + wt)


func _reconcile_frame_rail(rail_name: String, extents: Vector2,
		flipped: bool, z_pos: float) -> MeshInstance3D:
	var rail_length: float = maxf(0.01, extents.y - extents.x)
	var center_x: float = (extents.x + extents.y) * 0.5
	var mi: MeshInstance3D = get_node_or_null(NodePath(rail_name)) as MeshInstance3D
	if mi == null:
		mi = MeshInstance3D.new()
		mi.name = rail_name
		add_child(mi, false, Node.INTERNAL_MODE_FRONT)
		mi.owner = self
	mi.mesh = ConveyorFrameMesh.create(rail_length, size.y)
	mi.set_surface_override_material(0, _frame_material)
	var rail_basis: Basis = Basis(Vector3.UP, PI) if flipped else Basis.IDENTITY
	mi.transform = Transform3D(rail_basis, Vector3(center_x, -size.y, z_pos))
	return mi


func request_side_guard_opening(arc_back: float, arc_front: float, side: String) -> void:
	if arc_front <= arc_back:
		return
	if side != "left" and side != "right":
		return
	var next: Array[SideGuardOpening] = side_guard_openings.duplicate(true)
	next.append(SideGuardOpening.make(arc_back, arc_front, side))
	side_guard_openings = next


func clear_side_guard_openings() -> void:
	if side_guard_openings.is_empty():
		return
	side_guard_openings = []


func _request_side_guard_rebuild() -> void:
	if _side_guard_rebuild_pending or not is_inside_tree():
		return
	_side_guard_rebuild_pending = true
	call_deferred("_rebuild_side_guards")


func _openings_for_side(side: String) -> Array[Vector2]:
	var ranges: Array[Vector2] = []
	for o: SideGuardOpening in side_guard_openings:
		if o == null or o.side != side:
			continue
		var s: float = o.arc_back
		var e: float = o.arc_front
		if e <= s:
			continue
		ranges.append(Vector2(s, e))
	ranges.sort_custom(func(a: Vector2, b: Vector2) -> bool: return a.x < b.x)
	var merged: Array[Vector2] = []
	for r: Vector2 in ranges:
		if merged.is_empty() or r.x > merged[-1].y:
			merged.append(r)
		else:
			merged[-1] = Vector2(merged[-1].x, maxf(merged[-1].y, r.y))
	return merged


func _subdivide_around_openings(start_x: float, end_x: float, openings: Array[Vector2]) -> Array[Vector2]:
	var subs: Array[Vector2] = [Vector2(start_x, end_x)]
	for opening: Vector2 in openings:
		var next_subs: Array[Vector2] = []
		for sub: Vector2 in subs:
			if opening.y <= sub.x or opening.x >= sub.y:
				next_subs.append(sub)
				continue
			if opening.x > sub.x:
				next_subs.append(Vector2(sub.x, opening.x))
			if opening.y < sub.y:
				next_subs.append(Vector2(opening.y, sub.y))
		subs = next_subs
	var out: Array[Vector2] = []
	for sub: Vector2 in subs:
		if sub.y - sub.x > _MIN_GUARD_LEN:
			out.append(sub)
	return out


func _rebuild_side_guards() -> void:
	_side_guard_rebuild_pending = false
	_side_guards.clear()
	var keep := PackedStringArray()
	if not (left_side_guards_enabled or right_side_guards_enabled):
		_remove_orphans_with_prefix(["SideGuardLeft_", "SideGuardRight_"], keep)
		return
	var half_w: float = size.z * 0.5
	var wt: float = ConveyorFrameMesh.WALL_THICKNESS
	var ft: float = ConveyorFrameMesh.FLANGE_THICKNESS
	if left_side_guards_enabled:
		var ext: Vector2 = _side_extents(-half_w)
		var subs: Array[Vector2] = _subdivide_around_openings(ext.x, ext.y, _openings_for_side("left"))
		for k in range(subs.size()):
			var sub: Vector2 = subs[k]
			var n: String = "SideGuardLeft_%d" % k
			keep.append(n)
			_emit_side_guard(n, sub.x, sub.y, false, -half_w - wt, ft)
	if right_side_guards_enabled:
		var ext: Vector2 = _side_extents(half_w)
		var subs: Array[Vector2] = _subdivide_around_openings(ext.x, ext.y, _openings_for_side("right"))
		for k in range(subs.size()):
			var sub: Vector2 = subs[k]
			var n: String = "SideGuardRight_%d" % k
			keep.append(n)
			_emit_side_guard(n, sub.x, sub.y, true, half_w + wt, ft)
	_remove_orphans_with_prefix(["SideGuardLeft_", "SideGuardRight_"], keep)


func _emit_side_guard(guard_name: String, sub_start: float, sub_end: float,
		flipped: bool, z_pos: float, flange_y: float) -> void:
	var sub_len: float = sub_end - sub_start
	var sub_mid: float = (sub_start + sub_end) * 0.5
	var guard_basis: Basis = Basis(Vector3.UP, PI) if flipped else Basis.IDENTITY
	var origin: Vector3 = Vector3(sub_mid, flange_y, z_pos)
	var sg: SideGuard = get_node_or_null(NodePath(guard_name)) as SideGuard
	if sg == null:
		sg = SideGuard.new()
		sg.name = guard_name
		add_child(sg, false, Node.INTERNAL_MODE_FRONT)
		sg.owner = self
	sg.length = sub_len
	sg.transform = Transform3D(guard_basis, origin)
	sg.arc_back = sub_start
	sg.arc_front = sub_end
	_side_guards.append(sg)


func _request_legs_refresh() -> void:
	if _legs_refresh_pending or not is_inside_tree():
		return
	_legs_refresh_pending = true
	call_deferred("_rebuild_legs")


func _rebuild_legs() -> void:
	_legs_refresh_pending = false
	if not is_inside_tree():
		return
	_legs.clear()
	var keep: Dictionary = {}
	if not legs_enabled or leg_model_scene == null:
		_remove_orphan_legs(keep)
		return
	var specs: Array = _compute_leg_specs(size.x)
	if specs.is_empty():
		_remove_orphan_legs(keep)
		return
	var leg_z_scale: float = maxf(0.1, size.z * 0.5)
	var node_xform: Transform3D = global_transform
	var cross_axis_world: Vector3 = node_xform.basis.z.normalized()
	var legs_normal_world: Vector3 = floor_plane.normal.slide(cross_axis_world)
	if legs_normal_world.length_squared() < 1.0e-6:
		_remove_orphan_legs(keep)
		return
	legs_normal_world = legs_normal_world.normalized()
	for spec: Dictionary in specs:
		var leg_name: String = spec["name"]
		var x: float = spec["x"]
		var belt_bottom_local: Vector3 = Vector3(x, -size.y, 0.0)
		var belt_bottom_world: Vector3 = node_xform * belt_bottom_local
		var foot_v: Variant = floor_plane.intersects_ray(belt_bottom_world, -legs_normal_world)
		if foot_v == null:
			foot_v = floor_plane.intersects_ray(belt_bottom_world, legs_normal_world)
		if foot_v == null:
			continue
		var foot_world: Vector3 = foot_v
		var leg_height: float = (belt_bottom_world - foot_world).dot(legs_normal_world)
		if leg_height <= 0.05:
			continue
		var leg: Node3D = get_node_or_null(NodePath(leg_name)) as Node3D
		if leg == null:
			leg = leg_model_scene.instantiate() as Node3D
			if leg == null:
				continue
			leg.name = leg_name
			add_child(leg, false, Node.INTERNAL_MODE_FRONT)
		leg.visible = true
		var foot_local: Vector3 = node_xform.affine_inverse() * foot_world
		leg.position = foot_local
		leg.scale = Vector3(1.0, leg_height, leg_z_scale)
		keep[leg_name] = true
		_legs.append(leg)
	_remove_orphan_legs(keep)


func _remove_orphan_legs(keep: Dictionary) -> void:
	for child in get_children(true):
		var n: String = String(child.name)
		if not n.begins_with("Leg_"):
			continue
		if keep.has(n):
			continue
		remove_child(child)
		child.queue_free()


func _compute_leg_specs(top_len: float) -> Array:
	var specs: Array = []
	var half_l: float = top_len * 0.5
	var coverage_min: float = -half_l + tail_end_attachment_offset if tail_end_leg_enabled else -half_l
	var coverage_max: float = half_l - head_end_attachment_offset if head_end_leg_enabled else half_l
	if tail_end_leg_enabled and coverage_min <= half_l and not _is_x_excluded(coverage_min, -half_l):
		specs.append({"name": _LEG_TAIL_NAME, "x": coverage_min})
	if middle_legs_enabled and middle_legs_spacing > 0.0:
		var tail_clear: float = tail_end_leg_clearance if tail_end_leg_enabled else 0.0
		var head_clear: float = head_end_leg_clearance if head_end_leg_enabled else 0.0
		var first: float = ceil((coverage_min + tail_clear) / middle_legs_spacing) * middle_legs_spacing
		var last: float = floor((coverage_max - head_clear) / middle_legs_spacing) * middle_legs_spacing
		var idx: int = 1
		var pos: float = first
		while pos <= last + 1.0e-6:
			if pos >= -half_l and pos <= half_l and not _is_x_excluded(pos, -half_l):
				specs.append({"name": "%s%d" % [_LEG_MIDDLE_PREFIX, idx], "x": pos})
				idx += 1
			pos += middle_legs_spacing
	if head_end_leg_enabled and coverage_max >= -half_l and coverage_max <= half_l \
			and not _is_x_excluded(coverage_max, -half_l):
		specs.append({"name": _LEG_HEAD_NAME, "x": coverage_max})
	return specs


func _is_x_excluded(x: float, tail_x: float) -> bool:
	if exclusion_start == 0.0 and exclusion_end == 0.0:
		return false
	return x >= tail_x + exclusion_start and x <= tail_x + exclusion_end


## Convex shape matching the splayed footprint.
func _rebuild_collision() -> void:
	if _simple_conveyor_shape == null:
		return
	var collision: CollisionShape3D = _simple_conveyor_shape.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if collision == null:
		return
	var half_w: float = size.z / 2.0
	var half_y: float = size.y / 2.0
	var tan_ds: float = tan(angle_downstream)
	var tan_us: float = tan(angle_upstream)
	var ds_left_x: float = size.x / 2.0 - half_w * tan_ds
	var ds_right_x: float = size.x / 2.0 + half_w * tan_ds
	var us_right_x: float = -size.x / 2.0 + half_w * tan_us
	var us_left_x: float = -size.x / 2.0 - half_w * tan_us
	var points := PackedVector3Array([
		Vector3(ds_left_x, half_y, -half_w),
		Vector3(ds_right_x, half_y, half_w),
		Vector3(us_right_x, half_y, half_w),
		Vector3(us_left_x, half_y, -half_w),
		Vector3(ds_left_x, -half_y, -half_w),
		Vector3(ds_right_x, -half_y, half_w),
		Vector3(us_right_x, -half_y, half_w),
		Vector3(us_left_x, -half_y, -half_w),
	])
	# Fresh ConvexPolygonShape3D: the packed-scene one is resource-cached across instances.
	var convex_shape := ConvexPolygonShape3D.new()
	convex_shape.points = points
	collision.shape = convex_shape
	_simple_conveyor_shape.position = Vector3(0, -size.y * 0.5, 0)


func _update_conveyor_velocity() -> void:
	if _simple_conveyor_shape == null:
		return
	if running and speed != 0.0:
		var vx: Vector3 = _simple_conveyor_shape.global_transform.basis.x.normalized()
		_simple_conveyor_shape.constant_linear_velocity = vx * speed
	else:
		_simple_conveyor_shape.constant_linear_velocity = Vector3.ZERO


func _physics_process(_delta: float) -> void:
	pass


func _on_simulation_started() -> void:
	running = true
	_update_conveyor_velocity()
	if enable_comms:
		_speed_tag.register(speed_tag_group_name, speed_tag_name)
		_running_tag.register(running_tag_group_name, running_tag_name)


func _on_simulation_ended() -> void:
	running = false
	_update_conveyor_velocity()


func _tag_group_initialized(tag_group_name_param: String) -> void:
	_speed_tag.on_group_initialized(tag_group_name_param)
	_running_tag.on_group_initialized(tag_group_name_param)


func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms:
		return
	if _speed_tag.matches_group(tag_group_name_param):
		speed = _speed_tag.read_float32()


func _update_flow_arrow() -> void:
	if not is_inside_tree():
		return
	if is_instance_valid(_flow_arrow):
		FlowDirectionArrow.unregister(_flow_arrow)
		_flow_arrow.queue_free()
		_flow_arrow = null
	if size.x <= 0.0:
		return
	_flow_arrow = FlowDirectionArrow.create(Vector3(size.x, 0.0, size.z))
	_flow_arrow.position = Vector3(0.0, 0.2, 0.0)
	add_child(_flow_arrow, false, Node.INTERNAL_MODE_FRONT)
	FlowDirectionArrow.register(_flow_arrow)
	if has_meta("is_preview"):
		_flow_arrow.visible = true


func _remove_orphans_with_prefix(prefixes: Array, keep: PackedStringArray) -> void:
	for child in get_children(true):
		var n: String = child.name
		if n in keep:
			continue
		for prefix: String in prefixes:
			if n.begins_with(prefix):
				remove_child(child)
				child.queue_free()
				break


func _remove_named_if_present(names: Array) -> void:
	for n: String in names:
		var c := get_node_or_null(NodePath(n))
		if is_instance_valid(c):
			remove_child(c)
			c.queue_free()
