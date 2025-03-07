@tool
class_name StackLightData
extends Resource

var segments: int = 0
var segment_data: StackSegmentData = load("res://src/StackLight/StackSegmentData.tres")
@export var segment_datas: Array = []

func init_segments(count: int) -> void:
	segments = count
	if segment_datas.is_empty():
		segment_datas = []
		for i in range(segments):
			segment_datas.append(segment_data.duplicate(true))
	else:
		var cache := []
		for i in range(count):
			cache.append(segment_datas[i].duplicate(true))
		segment_datas = cache

func set_segments(count: int) -> void:
	if count == segments:
		return
	var cache := []
	if count < segments:
		for i in range(count):
			cache.append(segment_datas[i])
	else:
		for i in range(count):
			if i < segments:
				cache.append(segment_datas[i])
			else:
				cache.append(segment_data.duplicate(true))
	segments = count
	segment_datas = cache
