using Godot;

[Tool]
public partial class Roller : Node3D
{
	StaticBody3D staticBody;
	RollerConveyor rollerConveyor;

	const float radius = 0.12f;
	const float baseLength = 2f;
	const float baseCylinderLength = 0.935097f * 2f;

	public override void _Ready()
	{
		staticBody = GetNode<StaticBody3D>("StaticBody3D");
		UseSharedMaterial();
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
		Vector3 localFront = GlobalTransform.Basis.Z.Normalized();
		staticBody.ConstantAngularVelocity = -localFront * speed / radius;
	}

	public void SetLength(float length)
	{
		Node3D leftEnd = GetNode<Node3D>("RollerMeshes/RollerEndL");
		Node3D rightEnd = GetNode<Node3D>("RollerMeshes/RollerEndR");
		Node3D cylinder = GetNode<Node3D>("RollerMeshes/RollerLength");
		leftEnd.Position = new Vector3(0f, 0f, -length / baseLength);
		rightEnd.Position = new Vector3(0f, 0f, length / baseLength);

		// We want to keep a constant amount of space at the ends of the cylinder.
		const float cylinderMargins = baseLength - baseCylinderLength;
		float newCylinderLength = length - cylinderMargins;
		cylinder.Scale = new Vector3(1f, 1f, newCylinderLength / baseCylinderLength);
	}

	void UseSharedMaterial() {
		MeshInstance3D leftEnd = GetNode<MeshInstance3D>("RollerMeshes/RollerEndL");
		MeshInstance3D rightEnd = GetNode<MeshInstance3D>("RollerMeshes/RollerEndR");
		MeshInstance3D middle = GetNode<MeshInstance3D>("RollerMeshes/RollerLength");

		RollerConveyor rollerConveyor = GetParent().GetParent() as RollerConveyor ?? GetParent().GetParent().GetParent() as RollerConveyor;

		if (rollerConveyor != null)
		{
			StandardMaterial3D material = rollerConveyor.rollerMaterial;

			leftEnd.SetSurfaceOverrideMaterial(0, material);
			rightEnd.SetSurfaceOverrideMaterial(0, material);
			middle.SetSurfaceOverrideMaterial(0, material);
		}

	}
}
