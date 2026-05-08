@tool
class_name SideGuardOpening
extends Resource

## Single opening cut through a conveyor's side-guard rail. `arc_back` /
## `arc_front` are 1D parameters along the side-guard axis (see SideGuard).


@export var arc_back: float = 0.0

@export var arc_front: float = 0.0

## "left"/"right" for straight conveyors; "inner"/"outer" for curved.
@export var side: String = "left"


func _init() -> void:
	# Per-instance ownership so duplicated conveyors don't share opening Resources.
	resource_local_to_scene = true


static func make(p_arc_back: float, p_arc_front: float, p_side: String) -> SideGuardOpening:
	var op := SideGuardOpening.new()
	op.arc_back = p_arc_back
	op.arc_front = p_arc_front
	op.side = p_side
	return op


## Deep-duplicates openings whose owner doesn't match `owner_id` (unbreaks duplicated conveyors).
static func claim_unique(openings: Array[SideGuardOpening], owner_id: int) -> void:
	const META: StringName = &"_owner_id"
	for i in range(openings.size()):
		var op: SideGuardOpening = openings[i]
		if op == null:
			continue
		var existing_id: int = int(op.get_meta(META, 0))
		if existing_id == 0 or existing_id == owner_id:
			op.set_meta(META, owner_id)
			op.resource_local_to_scene = true
		else:
			var dup := op.duplicate(true) as SideGuardOpening
			dup.set_meta(META, owner_id)
			dup.resource_local_to_scene = true
			openings[i] = dup
