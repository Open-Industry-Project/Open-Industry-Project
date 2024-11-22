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

	protected virtual Transform3D ConstrainApparentTransform(Transform3D transform)
	{
		var basis = transform.Basis.Orthonormalized();
		return new Transform3D(basis, transform.Origin);
	}

	internal Transform3D PreventScaling()
	{
		return PreventScaling(Transform, assembly);
	}

	private Transform3D PreventScaling(Transform3D transform, ConveyorAssembly assembly)
	{
		if (!IsInstanceValid(assembly)) return ConstrainApparentTransform(transform);
		var apparentTransform = ConveyorAssembly.UnapplyInverseScaling(assemblyBasisAtLastRescale, transform);
		apparentTransform = ConstrainApparentTransform(apparentTransform);
		assemblyBasisAtLastRescale = assembly.Basis;
		var result = ConveyorAssembly.ApplyInverseScaling(assemblyBasisAtLastRescale, apparentTransform);
		return result;
	}
}
