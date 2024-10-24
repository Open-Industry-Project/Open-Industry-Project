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
				Roller roller = GetChild<Roller>(GetChildCount() - i);
				OnRollerRemoved(roller);
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
		AddChild(roller);
		roller.Position = new Vector3(rollersDistance * GetChildCount(), 0, 0);
		OnRollerAdded(roller);
		FixRollers();
	}

	void FixRollers()
	{
		((Roller)GetChild(0)).Position = new Vector3(rollersDistance, 0, 0);
	}
}
