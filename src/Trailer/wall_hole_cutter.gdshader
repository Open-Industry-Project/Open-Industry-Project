shader_type spatial;
render_mode cull_disabled;

uniform sampler2D albedo_texture : source_color, filter_linear_mipmap, repeat_enable;
uniform float roughness : hint_range(0.0, 1.0) = 0.5;

global uniform vec3 trailer_hole_center;
global uniform vec3 trailer_hole_half_extents;
global uniform float trailer_hole_active;

varying vec3 v_world_position;

void vertex() {
	v_world_position = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	ALBEDO = texture(albedo_texture, UV).rgb;
	ROUGHNESS = roughness;

	if (trailer_hole_active > 0.5) {
		vec3 delta = abs(v_world_position - trailer_hole_center);
		if (all(lessThan(delta, trailer_hole_half_extents))) {
			discard;
		}
	}
}
