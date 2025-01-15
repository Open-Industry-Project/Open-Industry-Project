using Godot;
using System;

[Tool]
public partial class RollerCorner : Node3D
{
	private float angularSpeed = 0f;
	private float uvSpeed = 0f;

	MeshInstance3D meshInstance => GetNode<MeshInstance3D>("MeshInstance3D");
	StaticBody3D staticBody => GetNode<StaticBody3D>("StaticBody3D");
	CollisionShape3D collisionShape => GetNode<CollisionShape3D>("StaticBody3D/CollisionShape3D");

	private Basis prevGlobalBasis = Basis.Identity;

	public RollerCorner()
	{
		SetNotifyTransform(true);
	}

	public override void _Notification(int what)
	{
		if (what == NotificationTransformChanged && IsInsideTree())
		{
			if (prevGlobalBasis == GlobalBasis) return;
			prevGlobalBasis = GlobalBasis;
			TryUpdateSpeed();
		}
		base._Notification(what);
	}

	public override void _EnterTree()
	{
		CallDeferred(MethodName.TryUpdateSpeed);
		base._EnterTree();
	}

	private void TryUpdateSpeed()
	{
		if (!IsInsideTree()) return;
		Vector3 localFront = GlobalTransform.Basis.Z.Normalized();
		staticBody.ConstantAngularVelocity = localFront * angularSpeed;
	}

	public void SetSpeed(float new_speed)
	{
		angularSpeed = new_speed;
		uvSpeed = angularSpeed / (2.0f * Mathf.Pi);
		TryUpdateSpeed();
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
