using Godot;

[Tool]
public partial class ChainTransferBases : Node3D
{
	public void SetChainsDistance(float distance)
	{
		foreach (ChainTransferBase chainBase in GetChildren())
		{
			chainBase.Position = new Vector3(0, 0, distance * chainBase.GetIndex());
		}
	}

	public void SetChainsSpeed(float speed)
	{
		foreach (ChainTransferBase chainBase in GetChildren())
		{
			chainBase.Speed = speed;
		}
	}

	public void SetChainsPopupChains(bool popupChains)
	{
		foreach (ChainTransferBase chainBase in GetChildren())
		{
			chainBase.Active = popupChains;
		}
	}

	public void TurnOnChains()
	{
		foreach (ChainTransferBase chainBase in GetChildren())
		{
			chainBase.TurnOn();
		}
	}

	public void TurnOffChains()
	{
		foreach (ChainTransferBase chainBase in GetChildren())
		{
			chainBase.TurnOff();
		}
	}

	public void RemoveChains(int count)
	{
		for (int i = 0; i < count; i++)
		{
			GetChild(GetChildCount() - 1 - i).QueueFree();
		}
	}

	public void FixChains(int chains)
	{
		int childCount = GetChildCount();
		int difference = childCount - chains;

		if (difference <= 0) return;

		for (int i = 0; i < difference; i++)
		{
			GetChild(GetChildCount() - 1 - i).QueueFree();
		}
	}
}
