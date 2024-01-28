using Godot;
using System;

[Tool]
public partial class LegsBar : MeshInstance3D
{
	ShaderMaterial shaderMaterial;
	LegsStand owner;
	
	public override void _Ready()
	{
		Mesh = Mesh.Duplicate() as Mesh;
		shaderMaterial = Mesh.SurfaceGetMaterial(0).Duplicate() as ShaderMaterial;
		Mesh.SurfaceSetMaterial(0, shaderMaterial);
		
		owner = Owner as LegsStand;
	}

	public override void _Process(double delta)
	{
		if (owner != null)
			shaderMaterial.SetShaderParameter("Scale", owner.Scale.Z);
	}
}
