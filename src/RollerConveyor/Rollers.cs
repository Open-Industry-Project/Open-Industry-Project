using Godot;

[Tool]
public partial class Rollers : Node3D
{
	[Export]
	PackedScene rollerScene;

	float rollersDistance = 0.33f;
	float _rollerLength = 2f;
	const float conveyorBaseWidth = 2f;
	float _rollerSkewAngleDegrees = 0;
	float _width = 2f;

	RollerConveyor owner;

	int initialForeignRollerCount;

	public void ChangeScale(Vector3 scale)
	{
		AddOrRemoveRollers(scale.X);
		SetWidth(scale.Z * conveyorBaseWidth);
        RescaleInverse(scale);
    }

	void SetWidth(float currentWidth)
	{
		_width = currentWidth;
		UpdateRollerLength();
	}

	public void SetRollerSkewAngle(float skewAngleDegrees)
	{
		_rollerSkewAngleDegrees = skewAngleDegrees;
		foreach (Roller roller in GetChildren())
		{
			roller.RotationDegrees = new Vector3(0, skewAngleDegrees, 0);
		}
		UpdateRollerLength();
	}

	public void UpdateRollerLength()  // TODO extract this up a level so RollerConveyorEnd can use it too.
	{
		if (Mathf.Abs(_rollerSkewAngleDegrees % 180f) == 90) return;
		float newLength = _width / Mathf.Cos(_rollerSkewAngleDegrees * 2f * Mathf.Pi / 360f);
		bool lengthChanged = newLength != _rollerLength;
		_rollerLength = newLength;
		if (lengthChanged)
		{
			foreach (Roller roller in GetChildren())
			{
				roller.SetLength(_rollerLength);
			}
		}
	}

	public void AddOrRemoveRollers(float conveyorLength)
	{
		int roundedLength = Mathf.RoundToInt(conveyorLength / rollersDistance) + 1;
		int rollerCount = GetChildCount();
		int desiredRollerCount = roundedLength - 2;

		int difference = desiredRollerCount - rollerCount;
		int foreignRollersMissing = initialForeignRollerCount - rollerCount;

		if (difference > 0)
		{
			for (int i = 0; i < difference; i++)
			{
				bool foreign = i < foreignRollersMissing;
				SpawnRoller(foreign);
			}
		}
		else if (difference < 0)
		{
			for (int i = 1; i <= -difference; i++)
			{
				GetChild<Roller>(GetChildCount() - i).QueueFree();
			}
		}
	}

	public override void _EnterTree()
	{
		owner = GetParent() as RollerConveyor;
	}

	public override void _Ready()
	{
		initialForeignRollerCount = GetForeignRollerCount();

		FixRollers();
	}

	void RescaleInverse(Vector3 parentScale)
	{
		Scale = new(1 / parentScale.X, 1 / parentScale.Y, 1 / parentScale.Z);
	}

	void SpawnRoller(bool foreign = false)
	{
		if (GetParent() == null || owner == null) return;
		Roller roller = rollerScene.Instantiate() as Roller;
		AddChild(roller);
		roller.Owner = foreign ? owner : GetTree().GetEditedSceneRoot();
		roller.Position = new Vector3(rollersDistance * GetChildCount(), 0, 0);
		roller.RotationDegrees = new Vector3(roller.RotationDegrees.X, owner.SkewAngle, roller.RotationDegrees.Z);
		roller.SetLength(_rollerLength);
		FixRollers();
	}

	void FixRollers()
	{
		((Roller)GetChild(0)).Position = new Vector3(rollersDistance, 0, 0);
	}

	int GetForeignRollerCount()
	{
		int count = 0;
		Node editedScene = GetTree().GetEditedSceneRoot();
		foreach (Node child in GetChildren())
		{
			if (child.Owner == editedScene)
			{
				break;
			}
			count++;
		}
		return count;
	}
}
