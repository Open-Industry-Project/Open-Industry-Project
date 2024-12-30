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
		return PreventScaling(Transform, assembly.Basis);
	}

	private Transform3D PreventScaling(Transform3D transform, Basis parentBasis)
	{
		if (!IsInstanceValid(assembly)) return ConstrainApparentTransform(transform);
		var apparentTransform = UnapplyInverseScaling(assemblyBasisAtLastRescale, transform);
		apparentTransform = ConstrainApparentTransform(apparentTransform);
		assemblyBasisAtLastRescale = parentBasis;
		var result = ApplyInverseScaling(assemblyBasisAtLastRescale, apparentTransform);
		return result;
	}
}

	internal static Transform3D UnapplyInverseScaling(Basis parentBasis, Transform3D childTransform)
	{
		var basisRotation = parentBasis.Orthonormalized();
		var basisScale = basisRotation.Inverse() * parentBasis;
		var xformScale = new Transform3D(basisScale, new Vector3(0, 0, 0));

		var apparentChildTransform = xformScale * childTransform;
		apparentChildTransform.Origin *= basisScale.Inverse();
		return apparentChildTransform;
	}

	internal static Transform3D ApplyInverseScaling(Basis parentBasis, Transform3D apparentChildTransform)
	{
		var basisRotation = parentBasis.Orthonormalized();
		var basisScale = basisRotation.Inverse() * parentBasis;
		var xformScaleInverse = new Transform3D(basisScale, new Vector3(0, 0, 0)).AffineInverse();

		var childTransform = apparentChildTransform;
		childTransform.Origin *= basisScale;
		childTransform = xformScaleInverse * childTransform;
		return childTransform;
	}
}
