using Godot;

[Tool]
public partial class Roller : Node3D
{
    MeshInstance3D meshInstance;
	StaticBody3D staticBody;

    const float radius = 0.12f;

	public override void _Ready()
	{
		staticBody = GetNode<StaticBody3D>("StaticBody3D");
		meshInstance = GetNode<MeshInstance3D>("MeshInstance3D");

		RollerConveyor rollerConveyor = GetParent().GetParent() as RollerConveyor ?? GetParent().GetParent().GetParent() as RollerConveyor;

        if (rollerConveyor != null)
		{
            StandardMaterial3D material = rollerConveyor.rollerMaterial;

            meshInstance.SetSurfaceOverrideMaterial(0, material);
        }
	}

	public void SetSpeed(float speed)
	{
        Vector3 localFront = GlobalTransform.Basis.Z.Normalized();
        staticBody.ConstantAngularVelocity = -localFront * speed / radius;
    }
}
