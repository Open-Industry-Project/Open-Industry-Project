@tool
extends PopupMenu

func _ready() -> void:
	set_item_icon(0, get_theme_icon("HelpSearch", "EditorIcons"))
	set_item_icon(2, get_theme_icon("ExternalLink", "EditorIcons"))
	set_item_icon(3, get_theme_icon("ActionCopy", "EditorIcons"))