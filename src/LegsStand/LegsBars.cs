using Godot;
using System;

[Tool]
public partial class LegsBars : Node3D
{
	[Export]
	PackedScene legsBarScene;
	
	float barsDistance = 1.0f;
	float parentScale = 1.0f;
	[Export]
	public float ParentScale
	{
		get
		{
			return parentScale;
		}
		set
		{
			int roundedScale = Mathf.FloorToInt(value) + 1;
			int barsCount = GetChildCount();
			
			if (roundedScale - 1 > barsCount && roundedScale != 0)
			{
				SpawnBar();
			}
			else if (barsCount > roundedScale - 1)
			{
				if (barsCount > 1)
				{
					RemoveBar();
				}
			}
			
			parentScale = value;
		}
	}
	
	LegsStand owner;
	
	public override void _Ready()
	{
		owner = Owner as LegsStand;
		FixBars();
	}
	
	public override void _PhysicsProcess(double delta)
	{
		if (owner != null)
		{
			Scale = new Vector3(1 / owner.Scale.X, 1 / owner.Scale.Y, 1);
		}
	}
	
	void SpawnBar()
	{
		if (GetParent() == null) return;
		Node3D legsBar = legsBarScene.Instantiate() as Node3D;
		AddChild(legsBar, forceReadableName: true);
		legsBar.Owner = GetParent();
		legsBar.Position = new Vector3(0, barsDistance * GetChildCount(), 0);
		FixBars();
	}
	
	void RemoveBar()
	{
		GetChild(GetChildCount() - 1).QueueFree();
	}

	void FixBars()
	{
		((Node3D)GetChild(0)).Owner = GetParent();
		((Node3D)GetChild(0)).Position = new Vector3(0, barsDistance, 0);
	}
}
