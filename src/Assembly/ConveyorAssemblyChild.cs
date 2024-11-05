using Godot;

[Tool]
public partial class ConveyorAssemblyChild : TransformMonitoredNode3D
{
	protected override Transform3D ConstrainTransform(Transform3D transform)
	{
		return transform;
	}
}
