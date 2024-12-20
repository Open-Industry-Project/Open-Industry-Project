using Godot;
using System;

[Tool]
public partial class RollerCorner : Node3D
{
	private float angularSpeed = 0f;
	private float uvSpeed = 0f;

	MeshInstance3D meshInstance;
	StaticBody3D staticBody;
	CollisionShape3D collisionShape;
	Root Main;

	public override void _Ready()
	{
		meshInstance = GetNode<MeshInstance3D>("MeshInstance3D");
		staticBody = GetNode<StaticBody3D>("StaticBody3D");
		collisionShape = GetNode<CollisionShape3D>("StaticBody3D/CollisionShape3D");
	}

	public override void _Process(double delta)
	{
		Main = GetParent().GetTree().EditedSceneRoot as Root;

		if (Main == null)
		{
			return;
		}
	}

	public override void _PhysicsProcess(double delta)
	{
		Vector3 localFront = GlobalTransform.Basis.Z.Normalized();
		staticBody.ConstantAngularVelocity = localFront * angularSpeed;
	}

	public void SetSpeed(float new_speed)
	{
		angularSpeed = new_speed;
		uvSpeed = angularSpeed / (2.0f * Mathf.Pi);
	}

	public Material GetMaterial()
	{
		return meshInstance.Mesh.SurfaceGetMaterial(0);
	}

	public void SetOverrideMaterial(Material material)
	{
		meshInstance.SetSurfaceOverrideMaterial(0, material);
	}
}
