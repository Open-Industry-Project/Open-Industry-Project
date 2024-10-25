using Godot;

[Tool]
public partial class Roller : Node3D
{
	StaticBody3D staticBody;
	MeshInstance3D leftEndMesh;
	MeshInstance3D rightEndMesh;
	MeshInstance3D cylinderMesh;

	const float radius = 0.12f;
	const float baseLength = 2f;
	const float baseCylinderLength = 0.935097f * 2f;

	float speed = 0f;
	Vector3 globalFront = Vector3.Zero;

	public override void _EnterTree()
	{
		SetNotifyTransform(true);
		UpdateGlobalFront();
		UpdatePhysics();
	}

	public override void _ExitTree()
	{
		SetNotifyTransform(false);
	}

	public override void _Notification(int what)
	{
		if (what == NotificationTransformChanged) {
			UpdateGlobalFront();
		}
	}

	void UpdateGlobalFront()
	{
		// GOTCHA: IsInsideTree() is false until `_EnterTree` is called, NOT
		// when the top-most parent is in the tree. GlobalBasis has the same
		// behavior. So, it's possible for parents to try to set our speed in
		// *their* `_EnterTree` without it actually updating our physics well.
		if (!IsInsideTree()) return;
		Vector3 newGlobalFront = GlobalBasis.Z.Normalized();
		if (globalFront != newGlobalFront)
		{
			globalFront = newGlobalFront;
			UpdatePhysics();
		}
	}

	private void EnsureNodeReferencesInitialized()
	{
		staticBody ??= GetNode<StaticBody3D>("StaticBody3D");
		leftEndMesh ??= GetNode<MeshInstance3D>("RollerMeshes/RollerEndL");
		rightEndMesh ??= GetNode<MeshInstance3D>("RollerMeshes/RollerEndR");
		cylinderMesh ??= GetNode<MeshInstance3D>("RollerMeshes/RollerLength");
	}

	public void SetSpeed(float speed)
	{
		this.speed = speed;
		UpdatePhysics();
	}

	private void UpdatePhysics()
	{
		EnsureNodeReferencesInitialized();
		staticBody.ConstantAngularVelocity = -globalFront * speed / radius;
	}

	public void SetLength(float length)
	{
		EnsureNodeReferencesInitialized();
		leftEndMesh.Position = new Vector3(0f, 0f, -length / baseLength);
		rightEndMesh.Position = new Vector3(0f, 0f, length / baseLength);

		// We want to keep a constant amount of space at the ends of the cylinder.
		const float cylinderMargins = baseLength - baseCylinderLength;
		float newCylinderLength = length - cylinderMargins;
		cylinderMesh.Scale = new Vector3(1f, 1f, newCylinderLength / baseCylinderLength);

		// staticBody has the same dimensions as cylinderMesh
		staticBody.Scale = new Vector3(1f, 1f, newCylinderLength / baseCylinderLength);
	}

	public void SetRollerOverrideMaterial(Material material) {
		EnsureNodeReferencesInitialized();
		leftEndMesh.SetSurfaceOverrideMaterial(0, material);
		rightEndMesh.SetSurfaceOverrideMaterial(0, material);
		cylinderMesh.SetSurfaceOverrideMaterial(0, material);
	}
}
