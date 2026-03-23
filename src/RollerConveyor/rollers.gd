@tool
class_name Rollers
extends AbstractRollerContainer

const ROLLERS_DISTANCE: float = 0.33
const ROLLERS_START_OFFSET: float = 0.2

## The scene to instantiate for each roller on the conveyor.
@export var roller_scene: PackedScene

func _init() -> void:
	super()
	length_changed.connect(_add_or_remove_rollers)

func _add_or_remove_rollers(conveyor_length: float) -> void:
	var available_length := conveyor_length - ROLLERS_START_OFFSET - ROLLERS_DISTANCE
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

func _apply_roller_length(roller: Roller) -> void:
	var base_x := ROLLERS_DISTANCE * (roller.get_index() + 1)
	var roller_conveyor_x := -_length / 2.0 + ROLLERS_START_OFFSET + base_x
	var skew_rad := deg_to_rad(_roller_skew_angle_degrees)

	var result := AbstractRollerContainer.calculate_clipped_roller(
		roller_conveyor_x,
		_effective_conveyor_half_length(),
		_roller_length,
		skew_rad,
	)

	var clipped_length := result.x
	var center_offset := result.y

	if clipped_length <= 0.0:
		roller.visible = false
		return

	roller.visible = true
	roller.set_length_and_offset(clipped_length, center_offset)
	roller.position = Vector3(base_x, 0.0, 0.0)
