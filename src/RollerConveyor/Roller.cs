using Godot;

[Tool]
public partial class Roller : Node3D
{
	MeshInstance3D meshInstance;
	StaticBody3D staticBody;
	RollerConveyor rollerConveyor;

	const float radius = 0.12f;
	Vector3 localFront;

	public override void _Ready()
	{
		localFront = GlobalTransform.Basis.Z.Normalized();
		staticBody = GetNode<StaticBody3D>("StaticBody3D");
		meshInstance = GetNode<MeshInstance3D>("MeshInstance3D");

		if (rollerConveyor != null)
		{
			StandardMaterial3D material = rollerConveyor.rollerMaterial;

			meshInstance.SetSurfaceOverrideMaterial(0, material);

			OnSetSpeed(rollerConveyor.Speed);
		}
	}

	public override void _EnterTree()
	{
		rollerConveyor = GetParent().GetParent() as RollerConveyor ?? GetParent().GetParent().GetParent() as RollerConveyor;

		if (rollerConveyor != null)
		{
			rollerConveyor.SetSpeed += OnSetSpeed;
		}
	}

	public override void _ExitTree()
	{
		if (rollerConveyor != null)
		{
			rollerConveyor.SetSpeed -= OnSetSpeed;
		}
	}

	private void OnSetSpeed(float speed)
	{
		localFront = GlobalTransform.Basis.Z.Normalized();
		staticBody.ConstantAngularVelocity = -localFront * speed / radius;
	}
}
