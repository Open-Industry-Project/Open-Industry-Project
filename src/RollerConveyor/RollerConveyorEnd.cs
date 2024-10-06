using Godot;
using System;

[Tool]
public partial class RollerConveyorEnd : Node3D
{
	[Export]
	bool flipped = false;
	Roller roller;
	Node3D owner;
	
	public override void _Ready()
	{
		roller = GetNode<Roller>("Roller");
		owner = Owner as Node3D;
	}

    public override void _Process(double delta)
    {
        if (owner != null)
        {
            Vector3 newScale = new(1 / owner.Scale.X, 1, 1);
            if (Scale != newScale)
            {
                Scale = newScale;
            }
        }
    }
	
	public void SetSpeed(float speed)
	{
		if (flipped)
			roller.speed = -speed;
		else
			roller.speed = speed;
	}
	
	public void RotateRoller(Vector3 angle)
	{
		roller.RotationDegrees = angle;
	}
}
