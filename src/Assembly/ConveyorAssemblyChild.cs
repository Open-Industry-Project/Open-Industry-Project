using Godot;

[Tool]
public partial class ConveyorAssemblyChild : TransformMonitoredNode3D
{
	private ConveyorAssembly assembly => GetParentOrNull<ConveyorAssembly>();
	public Transform3D ApparentTransform
	{
		get => apparentTransform;
		set
		{
			apparentTransform = ConstrainApparentTransform(value);
			ApplyApparentTransform();
		}
	}
	private Transform3D apparentTransform = Transform3D.Identity;

	public ConveyorAssemblyChild()
	{
		// A reasonable default.
		apparentTransform = Transform;
		if (GetParentOrNull<Node3D>() is Node3D parent)
		{
			apparentTransform = LocalToApparent(parent.Basis, Transform);
		}
	}

	protected override Transform3D ConstrainTransform(Transform3D transform)
	{
		// Note: This method must set apparentTransform if overridden.
		// This is how 3D gizmos update the ApparentTransform.
		apparentTransform = ConstrainApparentTransform(LocalToApparent(assembly.Basis, transform));
		return ApparentToLocal(assembly.Basis, apparentTransform);
	}

	protected virtual Transform3D ConstrainApparentTransform(Transform3D transform)
	{
		return transform;
	}

	public virtual void OnAssemblyTransformChanged()
	{
		ApplyApparentTransform();
	}

	private void ApplyApparentTransform()
	{
		Transform3D newTransform = ApparentToLocal(assembly.Basis, apparentTransform);
		Transform = newTransform;
	}

	internal static Transform3D LocalToApparent(Basis parentBasis, Transform3D childTransform)
	{
		// Parent's skew is not removed if there is any.
		var basisScale = Basis.Identity.Scaled(parentBasis.Scale);
		var xformScale = new Transform3D(basisScale, new Vector3(0, 0, 0));

		var apparentChildTransform = xformScale * childTransform;
		return apparentChildTransform;
	}

	internal static Transform3D ApparentToLocal(Basis parentBasis, Transform3D apparentChildTransform)
	{
		var basisScale = Basis.Identity.Scaled(parentBasis.Scale);
		var xformScaleInverse = new Transform3D(basisScale, new Vector3(0, 0, 0)).AffineInverse();

		var childTransform = apparentChildTransform;
		childTransform = xformScaleInverse * childTransform;
		return childTransform;
	}

	internal static Vector3 LocalToApparent(Basis parentBasis, Vector3 childPosition)
	{
		return parentBasis.Scale * childPosition;
	}

	internal static Vector3 ApparentToLocal(Basis parentBasis, Vector3 apparentChildPosition)
	{
		return parentBasis.Scale.Inverse() * apparentChildPosition;
	}
}
