using Godot;
using System;

[Tool]
public partial class Roller : Node3D
{
	public float speed = 1.0f;
	MeshInstance3D meshInstance;
	StaticBody3D staticBody;
	Root Main;

	public override void _Ready()
	{
		meshInstance = GetNode<MeshInstance3D>("MeshInstance3D");
		staticBody = GetNode<StaticBody3D>("StaticBody3D");
	}

	public override void _Process(double delta)
	{

		Main = GetParent().GetTree().EditedSceneRoot as Root;

		if (Main == null)
		{
			return;
		}

		if (Main.Start)
		{
			meshInstance.RotateZ(speed * MathF.PI * 2f * (float)delta);
		}
	}

	public override void _PhysicsProcess(double delta)
	{
		Vector3 localFront = GlobalTransform.Basis.Z.Normalized();
		staticBody.ConstantAngularVelocity = localFront * speed * MathF.PI * 2;
	}
}
