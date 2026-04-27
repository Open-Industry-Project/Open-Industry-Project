@tool
class_name StructureLiveSnap
extends Node

## Live snap for Platform / Stairs / GuardRail. Hold Alt to escape.

const SNAP_DISABLE_MODIFIER: Key = KEY_ALT
const SNAP_MIN_SWITCH_MS: int = 140

var _selected: Node3D = null
var _target: Node3D = null
var _snap_result: Dictionary = {}
## Variant so null means "not yet captured".
var _pre_snap_transform: Variant = null
var _pre_snap_size: Variant = null
var _active_snap: bool = false
## Re-entry guard for our own commit_action firing history_changed.
var _committing: bool = false
## Sticky target to suppress flip-flop between near-equal candidates.
var _locked_target: Node3D = null
var _last_applied: Transform3D = Transform3D.IDENTITY
var _last_switch_msec: int = 0


func _enter_tree() -> void:
	if not Engine.is_editor_hint():
		return
	set_process(true)
	EditorInterface.get_editor_undo_redo().history_changed.connect(_on_undo_history_changed)
	get_tree().node_added.connect(_on_node_added_for_preview)


func _exit_tree() -> void:
	if not Engine.is_editor_hint():
		return
	var undo_redo := EditorInterface.get_editor_undo_redo()
	if undo_redo.history_changed.is_connected(_on_undo_history_changed):
		undo_redo.history_changed.disconnect(_on_undo_history_changed)
	if get_tree() and get_tree().node_added.is_connected(_on_node_added_for_preview):
		get_tree().node_added.disconnect(_on_node_added_for_preview)


func _process(_delta: float) -> void:
	if not Engine.is_editor_hint():
		return
	_ensure_hook()


func _on_undo_history_changed() -> void:
	if _committing:
		return
	if _active_snap and _pre_snap_transform != null:
		_commit()
	_reset()


func _on_node_added_for_preview(node: Node) -> void:
	if not Engine.is_editor_hint():
		return
	if not (node is Node3D) or not _is_snappable(node as Node3D):
		return
	var edited_root := EditorInterface.get_edited_scene_root()
	if edited_root == null:
		return
	# Drop previews live outside the edited root.
	if edited_root == node or edited_root.is_ancestor_of(node):
		return
	if node.has_meta(&"_snap_transform"):
		return
	node.set_meta(&"_snap_transform", _on_preview_snap.bind(node))


func _on_preview_snap(proposed: Transform3D, node: Node3D) -> Transform3D:
	if not ConveyorSnapping.live_snap_enabled or Input.is_physical_key_pressed(SNAP_DISABLE_MODIFIER):
		return proposed
	var found := _find_snap(node, proposed)
	if found.is_empty():
		return proposed
	# Equality guard: size setter triggers a full mesh rebuild.
	if found.has("size") and node is ResizableNode3D:
		var resizable := node as ResizableNode3D
		if not resizable.size.is_equal_approx(found.size):
			resizable.size = found.size
	return found.transform


func _ensure_hook() -> bool:
	var selected := _pick_snappable()
	if selected == null:
		if _pre_snap_transform == null:
			_unhook()
			_reset()
		return false

	if _selected != null and _selected != selected:
		if _active_snap and _pre_snap_transform != null:
			_commit()
		_unhook()
		_reset()

	_selected = selected
	# Always rebind: Ctrl+D copies meta, so the duplicate would stay bound to the original.
	selected.set_meta(&"_snap_transform", _on_gizmo_transform.bind(selected))
	return true


func _unhook() -> void:
	if _selected != null and is_instance_valid(_selected):
		_selected.remove_meta(&"_snap_transform")


func _reset() -> void:
	_selected = null
	_target = null
	_snap_result = {}
	_pre_snap_transform = null
	_pre_snap_size = null
	_active_snap = false
	_locked_target = null
	_last_applied = Transform3D.IDENTITY
	_last_switch_msec = 0


func _on_gizmo_transform(proposed: Transform3D, selected: Node3D) -> Transform3D:
	if not ConveyorSnapping.live_snap_enabled or Input.is_physical_key_pressed(SNAP_DISABLE_MODIFIER):
		_active_snap = false
		return proposed

	var found := _find_snap(selected, proposed)
	if found.is_empty():
		_active_snap = false
		return proposed

	if _pre_snap_transform == null:
		_pre_snap_transform = proposed
		if selected is ResizableNode3D:
			_pre_snap_size = (selected as ResizableNode3D).size
	_target = found.target if found.has("target") else null
	_snap_result = found
	if found.has("size") and selected is ResizableNode3D:
		var resizable := selected as ResizableNode3D
		if not resizable.size.is_equal_approx(found.size):
			resizable.size = found.size
	_active_snap = true
	return found.transform


func _commit() -> void:
	if _snap_result.is_empty() or not is_instance_valid(_selected):
		return
	var undo_redo := EditorInterface.get_editor_undo_redo()
	_committing = true
	undo_redo.create_action("Snap Structure")
	# Bundle transform with size so one Ctrl+Z reverts both.
	if _snap_result.has("size") and _selected is ResizableNode3D and _pre_snap_size != null:
		undo_redo.add_do_property(_selected, "size", _snap_result.size)
		undo_redo.add_undo_property(_selected, "size", _pre_snap_size)
	if _pre_snap_transform != null:
		undo_redo.add_do_property(_selected, "global_transform", _snap_result.transform)
		undo_redo.add_undo_property(_selected, "global_transform", _pre_snap_transform)
	undo_redo.commit_action()
	_committing = false


## Target-lock + time hysteresis to suppress flicker between near-equal candidates.
func _find_snap(selected: Node3D, intent: Transform3D) -> Dictionary:
	if _locked_target != null and is_instance_valid(_locked_target):
		var locked := _snap_to_locked(selected, intent)
		if not locked.is_empty():
			return _record_applied(locked)
		_locked_target = null

	var found := _best_snap(selected, intent)
	if found.is_empty():
		return {}

	if _last_applied != Transform3D.IDENTITY:
		var next_t := found.transform as Transform3D
		var switching := _last_applied.origin.distance_to(next_t.origin) > 0.0001 or not _last_applied.basis.is_equal_approx(next_t.basis)
		var recently_switched := Time.get_ticks_msec() - _last_switch_msec < SNAP_MIN_SWITCH_MS
		if switching and recently_switched:
			return {"transform": _last_applied, "target": _locked_target}

	if found.has("target"):
		var tgt = found.target
		if tgt is Platform or tgt is GuardRail:
			_locked_target = tgt as Node3D
	return _record_applied(found)


func _record_applied(found: Dictionary) -> Dictionary:
	var t := found.transform as Transform3D
	if _last_applied == Transform3D.IDENTITY or _last_applied.origin.distance_to(t.origin) > 0.0001 or not _last_applied.basis.is_equal_approx(t.basis):
		_last_switch_msec = Time.get_ticks_msec()
	_last_applied = t
	return found


func _snap_to_locked(selected: Node3D, intent: Transform3D) -> Dictionary:
	if _locked_target is Platform:
		return StructureSnapping.find_snap_to_specific_platform(selected, _locked_target as Platform, intent)
	if _locked_target is GuardRail and selected is GuardRail:
		return StructureSnapping.find_snap_to_specific_guardrail(selected, _locked_target as GuardRail, intent)
	return {}


## Platforms are always eligible; a GuardRail can also snap to another GuardRail.
func _best_snap(selected: Node3D, intent: Transform3D) -> Dictionary:
	var platform_best := StructureSnapping.find_best_snap_to_platform(selected, intent)
	if not (selected is GuardRail):
		return platform_best
	var rail_best := StructureSnapping.find_best_snap_to_guardrail(selected, intent)
	if platform_best.is_empty():
		return rail_best
	if rail_best.is_empty():
		return platform_best
	return rail_best if float(rail_best.distance) < float(platform_best.distance) else platform_best


## Multi-select skips snap; otherwise the hooked node oscillates against
## siblings the gizmo moves in lockstep.
static func _pick_snappable() -> Node3D:
	var selection := EditorInterface.get_selection()
	if selection == null:
		return null
	var found: Node3D = null
	for n in selection.get_selected_nodes():
		if n is Node3D and _is_snappable(n):
			if found != null:
				return null
			found = n
	return found


static func _is_snappable(node: Node3D) -> bool:
	return node is Platform or node is Stairs or node is GuardRail
