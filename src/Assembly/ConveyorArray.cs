using System.Collections.Generic;
using Godot;

[Tool]
public partial class ConveyorArray : Node3D
{
	[Export(PropertyHint.None, "suffix:m")]
	public float Width { get => _width; set => SetProcessIfChanged(ref _width, value); }
	private float _width = 2f;

	[Export(PropertyHint.None, "suffix:m")]
	public float Length { get => _length; set => SetProcessIfChanged(ref _length, value); }
	private float _length = 4f;

	[Export(PropertyHint.Range, "-70,70,1,radians_as_degrees")]
	public float AngleDownstream { get => _angleDownstream; set => SetProcessIfChanged(ref _angleDownstream, value); }
	private float _angleDownstream = 0f;

	[Export(PropertyHint.Range, "-70,70,1,radians_as_degrees")]
	public float AngleUpstream { get => _angleUpstream; set => SetProcessIfChanged(ref _angleUpstream, value); }
	private float _angleUpstream = 0f;

	[Export(PropertyHint.Range, "1,20,1")]
	public int ConveyorCount { get => _conveyorCount; set => SetProcessIfChanged(ref _conveyorCount, value); }
	private int _conveyorCount = 4;

	[Export]
	public PackedScene ConveyorScene
	{
		get => _conveyorScene;
		set
		{
			if (!SetProcessIfChanged(ref _conveyorScene, value)) return;
			// Recreate all conveyors.
			AddOrRemoveConveyors(0);
		}
	}
	private PackedScene _conveyorScene = GD.Load<PackedScene>("res://parts/BeltConveyor.tscn");

	const float ConveyorSceneBaseLength = 1f;
	const float ConveyorSceneBaseWidth = 2f;

	public override void _Process(double delta)
	{
		UpdateConveyors();
		SetProcess(false);
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

	private bool SetProcessIfChanged<T>(ref T cachedVal, T newVal)
	{
		bool changed = !EqualityComparer<T>.Default.Equals(newVal, cachedVal);
		cachedVal = newVal;
		if (changed) SetProcess(true);
		return changed;
	}
}
