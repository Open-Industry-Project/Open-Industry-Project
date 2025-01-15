using Godot;
using System;

[Tool]
public partial class ConveyorEnd : Node3D
{
	public float Speed { get => speed; set
		{
			speed = value;
			UpdateBeltMaterialScale();
			UpdateBeltMaterialPosition();
		}
	}
	float speed = 2.0f;
	double beltPosition = 0.0;
	bool running = false;

	StaticBody3D staticBody;
	MeshInstance3D mesh;
	public ShaderMaterial beltMaterial;
	Shader beltShader;

	Root main;

	float prevScaleX;

	public override void _Ready()
	{
		staticBody = GetNode<StaticBody3D>("StaticBody3D");

		mesh = GetNode<MeshInstance3D>("MeshInstance3D");
		mesh.Mesh = mesh.Mesh.Duplicate() as Mesh;
		beltMaterial = mesh.Mesh.SurfaceGetMaterial(0).Duplicate() as ShaderMaterial;
		mesh.Mesh.SurfaceSetMaterial(0, beltMaterial);
		beltShader = beltMaterial.Shader.Duplicate() as Shader;
		beltMaterial.Shader = beltShader;

		main = GetTree().EditedSceneRoot as Root;
	}

	public void OnOwnerScaleChanged(Vector3 newOwnerScale)
	{
		if (newOwnerScale.X != prevScaleX)
		{
			Scale = new Vector3(1 / newOwnerScale.X, 1, 1);
			prevScaleX = newOwnerScale.X;
		}
	}

	public override void _PhysicsProcess(double delta)
	{
		if (main == null) return;

		if (main.Start)
		{
			Vector3 localFront = GlobalTransform.Basis.Z.Normalized();
			if (!main.simulationPaused)
				beltPosition += Speed * delta;
			if (beltPosition >= 1.0)
				beltPosition = 0.0;
			const float radius = 0.25f;
			staticBody.ConstantAngularVelocity = localFront * Speed / radius;
			UpdateBeltMaterialPosition();
		}
		else
		{
			beltPosition = 0; // Remove from here when signals are fixed.
			staticBody.ConstantAngularVelocity = Vector3.Zero;
			UpdateBeltMaterialPosition();
		}
	}

	public void UpdateBeltMaterialScale()
	{
		if (Speed != 0)
		{
			((ShaderMaterial)beltMaterial)?.SetShaderParameter("Scale", Mathf.Sign(Speed));
		}
	}

	public void UpdateBeltMaterialPosition()
	{
		((ShaderMaterial)beltMaterial)?.SetShaderParameter("BeltPosition", beltPosition * Mathf.Sign(-Speed));
	}
}
