using Godot;

[Tool]
public partial class ConveyorArray : Node3D
{
	[Export(PropertyHint.None, "suffix:m")]
	public float Width = 2f;

	[Export(PropertyHint.None, "suffix:m")]
	public float Length = 4f;

	[Export(PropertyHint.Range, "-70,70,1,radians_as_degrees")]
	public float AngleDownstream = 0f;

	[Export(PropertyHint.Range, "-70,70,1,radians_as_degrees")]
	public float AngleUpstream = 0f;

	[Export(PropertyHint.Range, "1,20,1")]
	public int ConveyorCount = 4;

	[Export]
	public PackedScene ConveyorScene = GD.Load<PackedScene>("res://parts/BeltConveyor.tscn");

	const float ConveyorSceneBaseLength = 1f;
	const float ConveyorSceneBaseWidth = 2f;

	public override void _Process(double delta)
	{
		UpdateConveyors();
	}

	private void UpdateConveyors()
	{
		AddOrRemoveConveyors(ConveyorCount);
		for (int i = 0; i < ConveyorCount; i++)
		{
			UpdateConveyor(i);
		}
	}

	private void AddOrRemoveConveyors(int conveyorCount)
	{
		while (GetChildCount() > conveyorCount && GetChildCount() > 0)
		{
			RemoveLastChild();
		}
		while (GetChildCount() < conveyorCount)
		{
			SpawnConveyor();
		}
	}

	private void RemoveLastChild()
	{
		var child = GetChild(GetChildCount() - 1);
		RemoveChild(child);
		child.QueueFree();
	}

	private void SpawnConveyor()
	{
		Node3D conveyor = ConveyorScene.Instantiate() as Node3D;
		AddChild(conveyor, false);
		conveyor.Owner = this;
	}

	private void UpdateConveyor(int index)
	{
		GetChild<Node3D>(index).Transform = GetNewTransformForConveyor(index);
	}

	private Transform3D GetNewTransformForConveyor(int index)
	{
		float slopeDownstream = Mathf.Tan(AngleDownstream);
		float slopeUpstream = Mathf.Tan(AngleUpstream);

		float width = Width / ConveyorCount;
		float posZ = -0.5f * Width + 0.5f * width + index * Width / ConveyorCount;
		float posX = (slopeDownstream * posZ + slopeUpstream * posZ) / 2f;
		float length = Length + slopeDownstream * posZ - slopeUpstream * posZ;

		var position = new Vector3(posX, 0, posZ);
		var scale = new Vector3(length / ConveyorSceneBaseLength, 1, width / ConveyorSceneBaseWidth);
		var transform = new Transform3D(Basis.Identity.Scaled(scale), position);
		return transform;
	}
}
