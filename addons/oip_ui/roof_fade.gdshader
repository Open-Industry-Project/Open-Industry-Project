shader_type spatial;
render_mode cull_back;

uniform sampler2D albedo_texture : source_color, filter_linear_mipmap, repeat_enable;
uniform float roughness : hint_range(0.0, 1.0) = 0.5;
uniform float fade_end : hint_range(0.0, 1.0) = 0.95;

void fragment() {
	ALBEDO = texture(albedo_texture, UV).rgb;
	ROUGHNESS = roughness;

	float look_down = INV_VIEW_MATRIX[2].y;
	if (look_down > fade_end) discard;
}
