using Godot;

[Tool]
public partial class Rollers : AbstractRollerContainer
{
	[Export]
	PackedScene rollerScene;

	float rollersDistance = 0.33f;

	public Rollers()
	{
		LengthChanged += AddOrRemoveRollers;
	}

	public override void _EnterTree()
	{
		foreach (Roller roller in GetRollers())
		{
			// If LengthChanged has already been fired, then we've already
			// added and subscribed some Rollers, but we still need to
			// subscribe the original ones. To ensure that each Roller is
			// only subscribed once, we're going to unsubscribe them all,
			// then let the base class resubscribe them all.
			EmitSignalRollerRemoved(roller);
		}
		base._EnterTree();
	}

	private void AddOrRemoveRollers(float conveyorLength)
	{
		int roundedLength = Mathf.RoundToInt(conveyorLength / rollersDistance) + 1;
		int rollerCount = GetChildCount();
		int desiredRollerCount = roundedLength - 2;

		int difference = desiredRollerCount - rollerCount;

		if (difference > 0)
		{
			for (int i = 0; i < difference; i++)
			{
				SpawnRoller();
			}
		}
		else if (difference < 0)
		{
			for (int i = 1; i <= -difference; i++)
			{
				Roller roller = GetChild<Roller>(rollerCount - i);
				EmitSignalRollerRemoved(roller);
				RemoveChild(roller);
				roller.QueueFree();
			}
		}
	}

	public override void _Ready()
	{
		FixRollers();
	}

	void RescaleInverse(Vector3 parentScale)
	{
		Scale = new(1 / parentScale.X, 1 / parentScale.Y, 1 / parentScale.Z);
	}

	void SpawnRoller()
	{
		Roller roller = rollerScene.Instantiate() as Roller;
		AddChild(roller, true);
		roller.Owner = this.Owner;
		roller.Position = new Vector3(rollersDistance * GetChildCount(), 0, 0);
		EmitSignalRollerAdded(roller);
		FixRollers();
	}

	void FixRollers()
	{
		((Roller)GetChild(0)).Position = new Vector3(rollersDistance, 0, 0);
	}
}
