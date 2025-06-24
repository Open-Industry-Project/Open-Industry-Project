@tool
extends EditorPlugin

var tag_group_enum: TagGroupOptionButtonPlugin = TagGroupOptionButtonPlugin.new()

func _enter_tree() -> void:
	add_inspector_plugin(tag_group_enum)


func _exit_tree() -> void:
	remove_inspector_plugin(tag_group_enum)

class TagGroupOptionButtonPlugin extends EditorInspectorPlugin:
	func _can_handle(object: Object) -> bool:
		return true
	
	func _parse_property(object: Object, type: Variant.Type, name: String, hint_type: PropertyHint, hint_string: String, usage_flags: int, wide: bool) -> bool:
		if type == TYPE_NIL and hint_string == "tag_group_enum":
			add_property_editor(name, TagGroupOptionButton.new())
			return true
		return false
		
class TagGroupOptionButton extends EditorProperty:
	var option_button: OptionButton
	var last_selected_index: int
	var groups: Array
	
	func _init() -> void:
		option_button = OptionButton.new()
		option_button.flat = true
		add_child(option_button)
		groups = OIPComms.get_tag_groups()
		for group in groups:
			option_button.add_item(group)
		option_button.item_selected.connect(func(index: int): get_edited_object().set(get_edited_property(), option_button.get_item_text(index)))
		OIPComms.tag_groups_registered.connect(_tag_groups_registered)
	
	func _update_property() -> void:
		var i: int = 0
		for group in OIPComms.get_tag_groups():
			if group == get_edited_object().get(get_edited_property()):
				last_selected_index = i
				option_button.select(i)
				break
			else:
				i += 1
							
	func _tag_groups_registered() -> void:
		option_button.clear()
		for group in OIPComms.get_tag_groups():
			option_button.add_item(group)
		option_button.select(last_selected_index)
				
