@tool
class_name ConveyorSnapPreview
extends Node

## Editor-only live snap with real guard mutation.
##
## Hooks into the gizmo via a "_snap_transform" Callable metadata on the
## selected node. The gizmo calls this BEFORE applying its computed transform,
## so the gizmo handle, mesh, and undo system all see the snapped result.
##
## While SNAP_MODIFIER (Alt) is held: the gizmo callback receives the proposed
## transform, runs the snap matcher, applies the guard plan directly to
## SideGuard / FrameRail nodes, and returns the snapped transform.
##
## On Alt release: revert live mutations, then re-apply through
## EditorUndoRedoManager as a single undoable action.

const SEARCH_RADIUS: float = 8.0
const VISIBLE_THRESHOLD: float = 3.0
const SNAP_MODIFIER: Key = KEY_ALT
const GUARD_SNAPSHOT_PROPS: Array = ["length", "position", "front_anchored", "back_anchored"]

var _modifier_was_held: bool = false
var _selected: Node3D = null
var _target: Node3D = null
var _snap_result: Dictionary = {}
var _snapshots: Dictionary = {}  ## Node -> {prop: original_value}.
var _last_applied: Dictionary = {}  ## Node -> {prop: last_written_value}.
var _created_guards: Array[SideGuard] = []
var _create_index: int = 0
var _mode_locked: bool = false
var _mode_is_end_to_end: bool = false


func _enter_tree() -> void:
	if not Engine.is_editor_hint():
		return
	set_process(true)


func _process(_delta: float) -> void:
	if not Engine.is_editor_hint():
		return

	var held := Input.is_physical_key_pressed(SNAP_MODIFIER)
	if held:
		if _ensure_hook() and not _modifier_was_held:
			_snap_once()
	elif _modifier_was_held:
		_unhook()
		_commit()
		_reset()
	_modifier_was_held = held


# -- Hook lifecycle -----------------------------------------------------------

func _ensure_hook() -> bool:
	var selected := _pick_snappable()
	if selected == null:
		_unhook()
		_revert_all()
		return false

	if _selected != null and _selected != selected:
		_unhook()
		_revert_all()
		_reset()

	_selected = selected
	if not selected.has_meta(&"_snap_transform"):
		selected.set_meta(&"_snap_transform", _on_gizmo_transform.bind(selected))
	return true


func _unhook() -> void:
	if _selected != null and is_instance_valid(_selected):
		_selected.remove_meta(&"_snap_transform")


func _reset() -> void:
	_selected = null
	_target = null
	_snap_result = {}
	_mode_locked = false
	_mode_is_end_to_end = false


# -- Snap entry points --------------------------------------------------------

func _snap_once() -> void:
	var found := _find_snap(_selected, _selected.global_transform)
	if found.is_empty():
		return
	_accept(found)
	_selected.global_transform = _snap_result.transform
	_apply_live()


func _on_gizmo_transform(proposed: Transform3D, selected: Node3D) -> Transform3D:
	var found := _find_snap(selected, proposed)
	if found.is_empty():
		return proposed

	var is_end: bool = found.result.get("is_end_to_end", false)
	if _mode_locked and is_end != _mode_is_end_to_end:
		return proposed

	_accept(found)
	_apply_live()
	return _snap_result.transform


func _accept(found: Dictionary) -> void:
	_target = found.target
	_snap_result = found.result
	if not _mode_locked:
		_mode_locked = true
		_mode_is_end_to_end = _snap_result.get("is_end_to_end", false)


# -- Live mutation ------------------------------------------------------------

func _apply_live() -> void:
	if _should_skip_guards(_selected, _snap_result):
		_revert_all()
		return
	_revert_modified()
	if not _try_apply_plan():
		_revert_all()


func _try_apply_plan() -> bool:
	var snap_xform: Transform3D = _snap_result.transform
	if ConveyorSnapping._is_diverter(_selected):
		var info := ConveyorSnapping._calculate_conveyor_intersection_for_transform(_selected, _target, snap_xform)
		if info.is_empty():
			return false
		var gap_plan: Array = ConveyorSnapping._plan_guard_changes(_target, info)
		if gap_plan.is_empty():
			return false
		_apply_guard_plan(gap_plan)
		return true
	var connection_plan: Array = ConveyorSnapping._plan_connection(_selected, _target, snap_xform)
	if connection_plan.is_empty():
		return false
	_apply_connection_plan(connection_plan)
	return true


static func _should_skip_guards(selected: Node3D, result: Dictionary) -> bool:
	return (
		result.get("is_end_to_end", false)
		or ConveyorSnapping._is_chain_transfer(selected)
		or ConveyorSnapping._is_blade_stop(selected)
	)


func _apply_guard_plan(gap_plan: Array) -> void:
	for change in gap_plan:
		if change.action == &"modify":
			var guard: SideGuard = change.guard
			if not is_instance_valid(guard):
				continue
			_snapshot_node(guard, GUARD_SNAPSHOT_PROPS)
			_set_if_changed(guard, &"length", change.new_length)
			_set_if_changed(guard, &"position", change.new_position)
			if change.set_front_anchored != null:
				_set_if_changed(guard, &"front_anchored", change.set_front_anchored)
			if change.set_back_anchored != null:
				_set_if_changed(guard, &"back_anchored", change.set_back_anchored)
		elif change.action == &"create":
			_apply_create(change)
	_trim_surplus_created()


func _apply_connection_plan(plan: Array) -> void:
	for entry in plan:
		if entry.has("gap_plan"):
			_apply_guard_plan(entry.gap_plan)
			continue
		if not entry.has("node"):
			continue
		var node: Node = entry.node
		if not is_instance_valid(node):
			continue
		var props: Dictionary = entry.props
		_snapshot_node(node, props.keys())
		for prop in props:
			_set_if_changed(node, prop, props[prop])


func _apply_create(change: Dictionary) -> void:
	var side_node: Node3D = change.side_node
	var guard_basis := Basis(Vector3.UP, PI) if change.side_str == "right" else Basis.IDENTITY
	var xform := Transform3D(guard_basis, change.new_position)
	var has_slot: bool = _create_index < _created_guards.size()

	if has_slot and is_instance_valid(_created_guards[_create_index]):
		var existing: SideGuard = _created_guards[_create_index]
		if existing.get_parent() != side_node:
			existing.get_parent().remove_child(existing)
			side_node.add_child(existing)
		if existing.length != change.new_length:
			existing.length = change.new_length
		if existing.transform != xform:
			existing.transform = xform
	else:
		var guard: SideGuard = change.sg_assembly._instantiate_guard()
		guard.set_meta(&"_live_preview_guard", true)
		guard.back_anchored = change.back_anchored
		guard.transform = xform
		guard.length = change.new_length
		side_node.add_child(guard)
		if has_slot:
			_created_guards[_create_index] = guard
		else:
			_created_guards.append(guard)
	_create_index += 1


func _trim_surplus_created() -> void:
	while _created_guards.size() > _create_index:
		var surplus: SideGuard = _created_guards.pop_back()
		if is_instance_valid(surplus):
			surplus.queue_free()
	_create_index = 0


func _snapshot_node(node: Node, props: Array) -> void:
	if _snapshots.has(node):
		return
	var snap: Dictionary = {}
	for prop in props:
		snap[prop] = node.get(prop)
	_snapshots[node] = snap


## Write a property only if it differs from last frame's value. Skips the
## _rebuild() that would otherwise fire on every setter call.
func _set_if_changed(node: Node, prop: StringName, value: Variant) -> void:
	if not _last_applied.has(node):
		_last_applied[node] = {}
	var last: Dictionary = _last_applied[node]
	if last.has(prop) and _approx_equal(last[prop], value):
		return
	node.set(prop, value)
	last[prop] = value


static func _approx_equal(a: Variant, b: Variant) -> bool:
	if typeof(a) != typeof(b):
		return false
	if a is float:
		return is_equal_approx(a, b)
	if a is Vector3:
		return (a as Vector3).is_equal_approx(b)
	return a == b


# -- Revert -------------------------------------------------------------------

func _revert_modified() -> void:
	SideGuard.suppress_rebuild = true
	FrameRail.suppress_rebuild = true
	for node in _snapshots.keys():
		if not is_instance_valid(node):
			continue
		var snap: Dictionary = _snapshots[node]
		for prop in snap:
			node.set(prop, snap[prop])
	_snapshots.clear()
	SideGuard.suppress_rebuild = false
	FrameRail.suppress_rebuild = false


func _revert_all() -> void:
	_revert_modified()
	_last_applied.clear()
	for g in _created_guards:
		if is_instance_valid(g):
			g.queue_free()
	_created_guards.clear()
	_create_index = 0


# -- Commit -------------------------------------------------------------------

func _commit() -> void:
	_revert_all()

	if _snap_result.is_empty() \
			or not is_instance_valid(_selected) \
			or not is_instance_valid(_target) \
			or _should_skip_guards(_selected, _snap_result):
		return

	var undo_redo := EditorInterface.get_editor_undo_redo()
	var is_diverter := ConveyorSnapping._is_diverter(_selected)
	var action_name := "Snap Diverter Sideguard Opening" if is_diverter else "Snap Conveyor Sideguard Opening"
	undo_redo.create_action(action_name)
	if is_diverter:
		ConveyorSnapping._open_side_guards_for_diverter(undo_redo, _snap_result.transform, _selected, _target)
	else:
		ConveyorSnapping._connect_side_guards(undo_redo, _selected, _target, _snap_result.transform)
	undo_redo.commit_action()

	_persist_state()


func _persist_state() -> void:
	for node in [_target, _selected]:
		var sg := ConveyorSnapping._find_side_guards_assembly(node)
		if sg and sg.has_method("save_guard_state"):
			sg.save_guard_state()
		if node.has_method("_save_frame_rail_state"):
			node._save_frame_rail_state()
		ConveyorSnapping._save_child_frame_rail_states(node)


# -- Candidate search ---------------------------------------------------------

static func _pick_snappable() -> Node3D:
	var selection := EditorInterface.get_selection()
	if selection == null:
		return null
	for n in selection.get_selected_nodes():
		if n is Node3D and _is_snappable(n):
			return n
	return null


static func _is_snappable(node: Node3D) -> bool:
	return (
		ConveyorSnapping._is_diverter(node)
		or ConveyorSnapping._is_blade_stop(node)
		or ConveyorSnapping._is_chain_transfer(node)
		or ConveyorSnapping._is_conveyor(node)
	)


static func _accepts_target(selected: Node3D, target: Node3D) -> bool:
	if target == selected:
		return false
	if not ConveyorSnapping._is_conveyor(target):
		return false
	if ConveyorSnapping._is_chain_transfer(selected) or ConveyorSnapping._is_blade_stop(selected):
		return ConveyorSnapping._is_roller_conveyor(target)
	return true


## Find the best snap target for the given intent transform. Uses
## ConveyorSnapping.selected_xform_override so the matcher sees the proposed
## pose without writing it to the node (which would cascade transform
## notifications through every descendant of complex assemblies).
static func _find_snap(selected: Node3D, intent: Transform3D) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {}

	var candidates: Array[Node3D] = []
	_collect_candidates(root, selected, candidates)

	ConveyorSnapping.selected_xform_override = intent

	var best: Dictionary = {}
	var best_target: Node3D = null
	var best_dist := INF
	for tgt in candidates:
		if tgt.global_position.distance_to(intent.origin) > SEARCH_RADIUS:
			continue
		var result := ConveyorSnapping._calculate_snap_transform(selected, tgt, true)
		if result.is_empty():
			continue
		var dist := intent.origin.distance_to(result.transform.origin)
		if dist > VISIBLE_THRESHOLD:
			continue
		if dist < best_dist:
			best_dist = dist
			best = result
			best_target = tgt

	ConveyorSnapping.selected_xform_override = null
	if best.is_empty():
		return {}
	return {"result": best, "target": best_target}


static func _collect_candidates(node: Node, selected: Node3D, out: Array[Node3D]) -> void:
	# Skip the selected's entire subtree — assembly children (e.g. spur's
	# internal conveyors) are not valid targets.
	if node == selected:
		return
	if node is Node3D and _accepts_target(selected, node):
		out.append(node)
	for child in node.get_children():
		_collect_candidates(child, selected, out)
