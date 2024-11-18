using Godot;

[Tool]
public partial class ConveyorAssemblyConveyors : ConveyorAssemblyChild
{
	private ConveyorAssembly assembly => GetParentOrNull<ConveyorAssembly>();

	protected override Transform3D ConstrainApparentTransform(Transform3D transform)
	{
		return base.ConstrainApparentTransform(assembly.LockConveyorsGroup(transform));
	}
}
