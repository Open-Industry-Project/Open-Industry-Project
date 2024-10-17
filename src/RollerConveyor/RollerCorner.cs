using Godot;
using System;

[Tool]
public partial class RollerCorner : Node3D
{
	private float angularSpeed = 0f;
	private float uvSpeed = 0f;

	MeshInstance3D meshInstance;
	StandardMaterial3D material;
	StaticBody3D staticBody;
	CollisionShape3D collisionShape;
	CurvedRollerConveyor owner;
	Root Main;

	public override void _Ready()
	{
		meshInstance = GetNode<MeshInstance3D>("MeshInstance3D");
		material = meshInstance.Mesh.SurfaceGetMaterial(0) as StandardMaterial3D;
		staticBody = GetNode<StaticBody3D>("StaticBody3D");
		collisionShape = GetNode<CollisionShape3D>("StaticBody3D/CollisionShape3D");
		owner = Owner as CurvedRollerConveyor;
	}

	public override void _Process(double delta)
	{
		Main = GetParent().GetTree().EditedSceneRoot as Root;

		if (Main == null)
		{
			return;
		}

		if (Main.simulationRunning)
		{
			material.Uv1Offset += new Vector3(uvSpeed * (float)delta, 0, 0);
		}
	}

	public override void _PhysicsProcess(double delta)
	{
		if (owner != null)
			Scale = new Vector3(1 / owner.Scale.X, 1, 1);

		Vector3 localFront = GlobalTransform.Basis.Z.Normalized();
		staticBody.ConstantAngularVelocity = localFront * angularSpeed;
	}

	public void SetSpeed(float new_speed)
	{
		angularSpeed = new_speed;
		uvSpeed = angularSpeed / (2.0f * Mathf.Pi);
	}
}
