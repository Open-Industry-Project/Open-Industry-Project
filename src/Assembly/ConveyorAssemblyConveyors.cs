using Godot;

[Tool]
public partial class ConveyorAssemblyConveyors : ConveyorAssemblyChild
{
	private ConveyorAssembly assembly => GetParentOrNull<ConveyorAssembly>();

	public override void _PhysicsProcess(double delta)
	{
		if (assembly == null) return;
		assembly.UpdateConveyors();
		SetNeedsUpdate(false);
	}

	protected override Transform3D ConstrainApparentTransform(Transform3D apparentTransform)
	{
		return assembly.LockConveyorsGroup(apparentTransform);
	}

	public float GetAngle()
	{
		return ApparentTransform.Basis.GetEuler().Z;
	}

	public void SetAngle(float angle)
	{
		Basis targetRot = new Basis(new Vector3(0, 0, 1), angle);
		ApparentTransform = new Transform3D(targetRot, ApparentTransform.Origin);
	}

	internal void SetNeedsUpdate(bool value)
	{
		SetPhysicsProcess(value);
	}
}
