@tool
class_name StructureSnapPreview
extends Node

## Alt-held live snap for structures during gizmo transforms (via _snap_transform hook).

const SNAP_MODIFIER: Key = KEY_ALT
const SNAP_MIN_SWITCH_MS: int = 140
const HOOK_STALE_MS: int = 120

var _modifier_was_held: bool = false
var _selected: Node3D = null
var _locked_target: Platform = null
var _last_applied: Transform3D = Transform3D.IDENTITY
var _last_switch_msec: int = 0
var _last_hook_msec: int = 0


func _enter_tree() -> void:
	if not Engine.is_editor_hint():
		return
	set_process(true)
	set_process_input(true)


func _process(_delta: float) -> void:
	if not Engine.is_editor_hint():
		return

	var held := Input.is_physical_key_pressed(SNAP_MODIFIER)
	if held:
		_ensure_hook()
		# Fallback in case the gizmo hook isn't firing in this editor context.
		if Time.get_ticks_msec() - _last_hook_msec > HOOK_STALE_MS:
			_apply_live_snap()
	elif _modifier_was_held:
		_unhook()
		_selected = null
		_locked_target = null

	_modifier_was_held = held


func _ensure_hook() -> void:
	var selected := _pick_snappable()
	if selected == null:
		_unhook()
		_selected = null
		_locked_target = null
		_last_applied = Transform3D.IDENTITY
		return

	if _selected != null and _selected != selected:
		_unhook()
		_locked_target = null
		_last_applied = Transform3D.IDENTITY

	_selected = selected
	if not _selected.has_meta(&"_snap_transform"):
		_selected.set_meta(&"_snap_transform", _on_gizmo_transform.bind(_selected))


func _unhook() -> void:
	if _selected != null and is_instance_valid(_selected):
		_selected.remove_meta(&"_snap_transform")
	_locked_target = null
	_last_applied = Transform3D.IDENTITY
	_last_switch_msec = 0
	_last_hook_msec = 0


func _on_gizmo_transform(proposed: Transform3D, selected: Node3D) -> Transform3D:
	_last_hook_msec = Time.get_ticks_msec()
	if selected == null or not is_instance_valid(selected):
		return proposed

	var found := _find_smooth_snap(selected, proposed)
	if found.is_empty():
		return proposed
	_accept_snap(found)
	return found.transform


func _input(event: InputEvent) -> void:
	if not Engine.is_editor_hint():
		return
	if not Input.is_physical_key_pressed(SNAP_MODIFIER):
		return
	if not (event is InputEventMouseButton):
		return
	var mb := event as InputEventMouseButton
	if mb.button_index != MOUSE_BUTTON_LEFT or not mb.pressed or mb.double_click:
		return
	_apply_live_snap(true)


func _apply_live_snap(commit_undo: bool = false) -> void:
	if _selected == null or not is_instance_valid(_selected):
		return
	var intent: Transform3D = _selected.global_transform
	var found := _find_smooth_snap(_selected, intent)
	if found.is_empty():
		return
	var snapped: Transform3D = found.transform
	var snapped_size: Variant = found.get("size")
	_accept_snap(found)
	if commit_undo:
		var undo_redo := EditorInterface.get_editor_undo_redo()
		undo_redo.create_action("Snap Structure (Alt)")
		if snapped_size != null and _selected is ResizableNode3D:
			undo_redo.add_do_property(_selected, "size", snapped_size)
			undo_redo.add_undo_property(_selected, "size", (_selected as ResizableNode3D).size)
		undo_redo.add_do_property(_selected, "global_transform", snapped)
		undo_redo.add_undo_property(_selected, "global_transform", _selected.global_transform)
		undo_redo.commit_action()
	else:
		if snapped_size != null and _selected is ResizableNode3D:
			(_selected as ResizableNode3D).size = snapped_size
		_selected.global_transform = snapped


func _find_smooth_snap(selected: Node3D, intent: Transform3D) -> Dictionary:
	# Prefer the currently locked target while Alt is held.
	if _locked_target != null and is_instance_valid(_locked_target):
		var locked := StructureSnapping.find_snap_to_specific_platform(selected, _locked_target, intent)
		if not locked.is_empty():
			return locked
		_locked_target = null

	var found := StructureSnapping.find_best_snap_to_platform(selected, intent)
	if found.is_empty():
		return {}

	# Time hysteresis: prevent flip-flops between near-equal adjacent-edge candidates.
	if _last_applied != Transform3D.IDENTITY:
		var next_t := found.transform as Transform3D
		var switching_transform := _last_applied.origin.distance_to(next_t.origin) > 0.0001 or not _last_applied.basis.is_equal_approx(next_t.basis)
		var recently_switched := Time.get_ticks_msec() - _last_switch_msec < SNAP_MIN_SWITCH_MS
		if switching_transform and recently_switched:
			return {
				"transform": _last_applied,
				"target": _locked_target,
			}

	return found


func _accept_snap(found: Dictionary) -> void:
	if found.has("target") and found.target is Platform:
		_locked_target = found.target as Platform
	if found.has("transform"):
		var t := found.transform as Transform3D
		if _last_applied == Transform3D.IDENTITY or _last_applied.origin.distance_to(t.origin) > 0.0001 or not _last_applied.basis.is_equal_approx(t.basis):
			_last_switch_msec = Time.get_ticks_msec()
		_last_applied = t


static func _pick_snappable() -> Node3D:
	var selection := EditorInterface.get_selection()
	if selection == null:
		return null
	for n in selection.get_selected_nodes():
		if n is Node3D and _is_snappable(n):
			return n
	return null


static func _is_snappable(node: Node3D) -> bool:
	return node is Platform or node is Stairs or node is GuardRail
