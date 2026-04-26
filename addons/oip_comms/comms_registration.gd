## Shared OIPComms tag-group registration. Extracted from the editor dock
## (oip_comms_dock.gd) so headless runners can register the same way.
##
## tag_groups_data items use the dock's on-disk shape:
##   { name, polling_rate, protocol, gateway, path, cpu }
## where `protocol` is the numeric string "0".."3" mapping to
## ab_eip / modbus_tcp / opc_ua / s7. `polling_rate` is a string in ms.
class_name OIPCommsRegistration


const PROTOCOLS := {
	"0": "ab_eip",
	"1": "modbus_tcp",
	"2": "opc_ua",
	"3": "s7",
}


static func register_tag_groups(tag_groups_data: Array) -> void:
	OIPComms.clear_tag_groups()
	for tag_group_data: Dictionary in tag_groups_data:
		var n: String = tag_group_data.name
		var pr: String = tag_group_data.polling_rate
		var pt: String = PROTOCOLS.get(String(tag_group_data.protocol), "")
		var g: String = tag_group_data.gateway
		var p: String = tag_group_data.path
		var c: String = tag_group_data.cpu
		OIPComms.register_tag_group(n, int(pr), pt, g, p, c)
	OIPComms.tag_groups_registered.emit()
