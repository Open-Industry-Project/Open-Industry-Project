using Godot;

[Tool]
public partial class ConveyorAssemblyChild : TransformMonitoredNode3D
{
	private ConveyorAssembly assembly => GetParentOrNull<ConveyorAssembly>();
	private Basis assemblyBasisAtLastRescale = Basis.Identity;

	protected override Transform3D ConstrainTransform(Transform3D transform)
	{
		return PreventScaling(transform, assembly);
	}

	internal Transform3D PreventScaling()
	{
		return PreventScaling(Transform, assembly);
	}

	private Transform3D PreventScaling(Transform3D transform, ConveyorAssembly assembly)
	{
		if (!IsInstanceValid(assembly)) return transform;
		var result = assembly.PreventChildScaling(transform, assemblyBasisAtLastRescale);
		assemblyBasisAtLastRescale = assembly.Basis;
		return result;
	}
}
