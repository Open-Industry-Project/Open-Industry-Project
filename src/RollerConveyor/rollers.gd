@tool
extends AbstractRollerContainer
class_name Rollers

@export var roller_scene: PackedScene

const ROLLERS_DISTANCE: float = 0.33

func _ready() -> void:
	fix_rollers()

func _get_rollers() -> Array[Roller]:
	var rollers: Array[Roller] = []
	for child in get_children():
		if child is Roller:
			rollers.append(child)
	return rollers

func set_length(conveyor_length: float) -> void:
	var rounded_length = round(conveyor_length / ROLLERS_DISTANCE) + 1
	var roller_count = get_child_count()
	var desired_roller_count = rounded_length - 2

	var difference = desired_roller_count - roller_count

	if difference > 0:
		for i in difference:
			spawn_roller()
	elif difference < 0:
		for i in range(1, -difference + 1):
			var roller = get_child(roller_count - i) as Roller
			emit_signal("roller_removed", roller)
			remove_child(roller)
			roller.queue_free()

func spawn_roller() -> void:
	var roller = roller_scene.instantiate() as Roller
	add_child(roller, true)
	roller.owner = self.owner
	roller.position = Vector3(ROLLERS_DISTANCE * get_child_count(), 0, 0)
	emit_signal("roller_added", roller)
	fix_rollers()

func fix_rollers() -> void:
	if get_child_count() > 0:
		var first_roller = get_child(0) as Roller
		if first_roller:
			first_roller.position = Vector3(ROLLERS_DISTANCE, 0, 0)
