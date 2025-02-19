using Godot;
using System;

[Tool]
public partial class NodeOPC : Node
{
	[Export]
	public string tag;
	public string Tag { get => tag; set => tag = value; }

	public Root Main { get; set; }

	bool updating = false;

	public enum Datatype
	{
		Bool,
		Float,
		Double,
		Int
	}

	[Export]
	public Datatype DataType
	{
		get { return _dataType; }
		set
		{
			_dataType = value;

			if (value == Datatype.Float )
			{
				Value = 0.0;
			} else if(value == Datatype.Double || value == Datatype.Int)
			{
				Value = 0;
			}
			else
			{
				Value = false;
			}
		}
	} 

	private Datatype _dataType = Datatype.Bool;


	[Export]
	public Godot.Variant Value
	{
		get { return _value; }
		set
		{
			if ((object)value == (object)_value) return;

			_value = value;

			if (!Main.simulationRunning)
			{
				return;
			}

			switch (_dataType)
			{
				case Datatype.Bool:
					WriteTag((bool)value);
					break;
				case Datatype.Float:
					WriteTag((float)value);
					break;
				case Datatype.Double:
					WriteTag((double)value);
					break;
				case Datatype.Int:
					WriteTag((int)value);
					break;
			}
		}
	}

	private Godot.Variant _value;

	readonly Guid id = Guid.NewGuid();

	public override void _EnterTree()
	{
		Main = GetParent().GetTree().EditedSceneRoot as Root;

		if (Main != null)
		{
			Main.SimulationStarted += OnSimulationStarted;
			Main.ValueChanged += OnValueChanged;
		}
	}

	void OnValueChanged(string tag, Godot.Variant value)
	{
		if (tag != this.tag) return;

		if ((object)value == (object)_value) return;

		Godot.Variant variantValue = false;

		switch (_dataType)
		{
			case Datatype.Bool:
				variantValue = (bool)value;
				break;
			case Datatype.Float:
				variantValue = (float)value;
				break;
			case Datatype.Double:
				variantValue = (double)value;
				break;
			case Datatype.Int:
				variantValue = (int)value;
				break;
		}

		Value = variantValue;
	}

	void OnSimulationStarted()
	{
		Main.Connect(id, Root.DataType.Float, Name, tag);
	}

	async void WriteTag<T>(T value)
	{
		try
		{
			await Main.Write(id, value);
		}
		catch(Exception e)
		{
			GD.Print(e.Message);
			GD.PrintErr("Failure to write: " + tag + " in Node: " + Name);
		}
	}
}
