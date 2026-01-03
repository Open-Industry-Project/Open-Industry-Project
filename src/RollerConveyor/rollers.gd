@tool
class_name Rollers
extends AbstractRollerContainer

const ROLLERS_DISTANCE: float = 0.33

## The scene to instantiate for each roller on the conveyor.
@export var roller_scene: PackedScene

func _init() -> void:
	super()
	length_changed.connect(_add_or_remove_rollers)

func _ready() -> void:
	_fix_rollers()

func _add_or_remove_rollers(conveyor_length: float) -> void:
	var available_length := conveyor_length - 0.2 - 0.33
	var rounded_length: int = int(floor(available_length / ROLLERS_DISTANCE))
	var roller_count := get_child_count()
	var desired_roller_count: int = max(0, rounded_length)

	var difference := desired_roller_count - roller_count

	if difference > 0:
		for i in difference:
			_spawn_roller()
	elif difference < 0:
		for i in range(1, -difference + 1):
			var roller := get_child(roller_count - i) as Roller
			roller_removed.emit(roller)
			remove_child(roller)
			roller.queue_free()

func _spawn_roller() -> void:
	var roller := roller_scene.instantiate() as Roller
	add_child(roller, true)
	roller.position = Vector3(ROLLERS_DISTANCE * get_child_count(), 0, 0)
	roller_added.emit(roller)
	_fix_rollers()

func _fix_rollers() -> void:
	if get_child_count() > 0:
		var first_roller := get_child(0) as Roller
		if first_roller:
			first_roller.position = Vector3(ROLLERS_DISTANCE, 0, 0)
