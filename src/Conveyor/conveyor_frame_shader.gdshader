shader_type spatial;
render_mode cull_disabled, shadows_disabled;

uniform sampler2D metal_texture : source_color, filter_linear_mipmap, repeat_enable;
uniform vec3 color : source_color = vec3(0.337, 0.655, 0.784);
uniform float metallic_value : hint_range(0.0, 1.0) = 0.3;
uniform float roughness_value : hint_range(0.0, 1.0) = 0.7;
uniform float specular_value : hint_range(0.0, 1.0) = 0.5;

void fragment() {
	vec3 tex = texture(metal_texture, UV).rgb;
	// Overlay blend to tint the metal texture.
	vec3 blended;
	for (int i = 0; i < 3; i++) {
		if (tex[i] < 0.5) {
			blended[i] = 2.0 * tex[i] * color[i];
		} else {
			blended[i] = 1.0 - 2.0 * (1.0 - tex[i]) * (1.0 - color[i]);
		}
	}
	ALBEDO = blended;
	METALLIC = metallic_value;
	ROUGHNESS = roughness_value;
	SPECULAR = specular_value;
}
