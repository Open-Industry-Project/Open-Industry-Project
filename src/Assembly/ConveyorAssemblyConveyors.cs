using Godot;

[Tool]
public partial class ConveyorAssemblyConveyors : ConveyorAssemblyChild
{
	private ConveyorAssembly assembly => GetParentOrNull<ConveyorAssembly>();

	protected override Transform3D ConstrainApparentTransform(Transform3D transform)
	{
		return base.ConstrainApparentTransform(assembly.LockConveyorsGroup(transform));
	}

	public void SetAngle(float angle)
	{
		PreventScaling();
		Basis scale = Basis.Identity.Scaled(assembly.Scale);
		Basis targetRot = new Basis(new Vector3(0, 0, 1), angle);
		this.Basis = scale.Inverse() * targetRot;
	}
}
