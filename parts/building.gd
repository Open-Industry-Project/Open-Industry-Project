@tool
class_name Building
extends Node3D

const _ROT_FRONT := 0
const _ROT_BACK := 10
const _ROT_LEFT := 16
const _ROT_RIGHT := 22

const _WALL_BIG := 0
const _WALL_CORNER_L := 2
const _WALL_CORNER_R := 3
const _WALL_MID := 4
const _WALL_TOP := 5

const _ROOF_CURVED := 0
const _ROOF_STRAIGHT := 1

## Number of wall segments along the building width (each segment is 8 m).
@export_range(2, 50) var width_sections: int = 8:
	set(value):
		width_sections = value
		_generate_building()

## Number of wall segments along the building length (each segment is 8 m).
@export_range(2, 50) var length_sections: int = 5:
	set(value):
		length_sections = value
		_generate_building()

## Number of WallBig layers stacked vertically (each layer adds ~8 m of height).
@export_range(1, 10) var height_sections: int = 1:
	set(value):
		height_sections = value
		_generate_building()

@export_range(0, 20, 0.1) var brightness: float = 6:
	set(value):
		brightness = value
		if not is_node_ready():
			return
		for light: OmniLight3D in lights.get_children():
			light.light_energy = brightness

@onready var floor_grid: GridMap = $Floor
@onready var walls_grid: GridMap = $Walls
@onready var roof_grid: GridMap = $Roof
@onready var lights: Node3D = $Lights


func _ready() -> void:
	if not Engine.is_editor_hint():
		_generate_building()


func _get_wall_bounds() -> Array[int]:
	var x_min := -(width_sections / 2)
	var x_max := x_min + width_sections
	var z_min := -(length_sections / 2)
	var z_max := z_min + length_sections
	return [x_min, x_max, z_min, z_max]


func _generate_building() -> void:
	if not is_node_ready():
		return
	_generate_floor()
	_generate_walls()
	_generate_roof()
	_update_lights()


func _generate_floor() -> void:
	floor_grid.clear()
	var b := _get_wall_bounds()
	var x_start: int = b[0] * 2
	var z_start: int = b[2] * 2
	var fw: int = width_sections * 2
	var fl: int = length_sections * 2

	for x in range(fw):
		for z in range(fl):
			floor_grid.set_cell_item(
				Vector3i(x_start + x, -1, z_start + z), 0
			)


func _generate_walls() -> void:
	walls_grid.clear()
	var b := _get_wall_bounds()
	var x0: int = b[0]
	var x1: int = b[1]
	var z0: int = b[2]
	var z1: int = b[3]

	for h in range(height_sections):
		_place_wall_ring(x0, x1, z0, z1, -1 + h * 2, _WALL_BIG)

	var top_y := -1 + height_sections * 2
	_place_wall_ring(x0, x1, z0, z1, top_y, _WALL_TOP)

	var mid_y := top_y + 1
	for x in range(x0, x1):
		walls_grid.set_cell_item(Vector3i(x, mid_y, z0), _WALL_MID, _ROT_FRONT)
	for x in range(x0 + 1, x1 + 1):
		walls_grid.set_cell_item(Vector3i(x, mid_y, z1), _WALL_MID, _ROT_BACK)

	walls_grid.set_cell_item(Vector3i(x0, mid_y, z0 + 1), _WALL_CORNER_R, _ROT_RIGHT)
	walls_grid.set_cell_item(Vector3i(x0, mid_y, z1), _WALL_CORNER_L, _ROT_LEFT)
	for z in range(z0 + 2, z1):
		walls_grid.set_cell_item(Vector3i(x0, mid_y, z), _WALL_BIG, _ROT_LEFT)

	walls_grid.set_cell_item(Vector3i(x1, mid_y, z0), _WALL_CORNER_L, _ROT_RIGHT)
	walls_grid.set_cell_item(Vector3i(x1, mid_y, z1 - 1), _WALL_CORNER_R, _ROT_LEFT)
	for z in range(z0 + 1, z1 - 1):
		walls_grid.set_cell_item(Vector3i(x1, mid_y, z), _WALL_BIG, _ROT_RIGHT)


func _place_wall_ring(x0: int, x1: int, z0: int, z1: int, y: int, item: int) -> void:
	for x in range(x0, x1):
		walls_grid.set_cell_item(Vector3i(x, y, z0), item, _ROT_FRONT)
	for x in range(x0 + 1, x1 + 1):
		walls_grid.set_cell_item(Vector3i(x, y, z1), item, _ROT_BACK)
	for z in range(z0 + 1, z1 + 1):
		walls_grid.set_cell_item(Vector3i(x0, y, z), item, _ROT_LEFT)
	for z in range(z0, z1):
		walls_grid.set_cell_item(Vector3i(x1, y, z), item, _ROT_RIGHT)


func _generate_roof() -> void:
	roof_grid.clear()
	var b := _get_wall_bounds()
	var x0: int = b[0]
	var x1: int = b[1]
	var z0: int = b[2]
	var z1: int = b[3]

	var roof_edge_y := -1 + height_sections * 2 + 2
	var roof_mid_y := roof_edge_y + 1

	for x in range(x0, x1):
		roof_grid.set_cell_item(Vector3i(x, roof_edge_y, z0), _ROOF_CURVED, _ROT_RIGHT)
	for x in range(x0 + 1, x1 + 1):
		roof_grid.set_cell_item(Vector3i(x, roof_edge_y, z1), _ROOF_CURVED, _ROT_LEFT)
	for x in range(x0 + 1, x1 + 1):
		for z in range(z0 + 2, z1):
			roof_grid.set_cell_item(Vector3i(x, roof_mid_y, z), _ROOF_STRAIGHT, _ROT_BACK)


func _update_lights() -> void:
	var b := _get_wall_bounds()
	var cs := 8.0
	var width_m := float(b[1] - b[0]) * cs
	var length_m := float(b[3] - b[2]) * cs

	var cols := clampi(ceili(width_m / 24.0), 1, 6)
	var rows := clampi(ceili(length_m / 24.0), 1, 6)
	var needed := cols * rows

	while lights.get_child_count() < needed:
		var new_light := OmniLight3D.new()
		new_light.shadow_enabled = true
		lights.add_child(new_light)
		if Engine.is_editor_hint() and get_tree():
			new_light.owner = get_tree().edited_scene_root

	while lights.get_child_count() > needed:
		var old := lights.get_child(lights.get_child_count() - 1)
		lights.remove_child(old)
		old.queue_free()

	var x_start := b[0] * cs
	var z_start := b[2] * cs
	var zone_w := width_m / cols
	var zone_l := length_m / rows

	var light_y := 2.0 + (2.0 * height_sections) * 4.0 - 1.0
	var zone_diag := sqrt(zone_w * zone_w + zone_l * zone_l)

	for i in range(needed):
		var col := i % cols
		var row := i / cols
		var light := lights.get_child(i) as OmniLight3D
		light.position = Vector3(
			x_start + zone_w * (col + 0.5),
			light_y,
			z_start + zone_l * (row + 0.5)
		)
		light.light_energy = brightness
		light.omni_range = zone_diag * 1.2
		light.shadow_enabled = true
