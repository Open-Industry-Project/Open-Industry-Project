using Godot;
using System;

[Tool]
public partial class ConveyorLeg : Node3D
{
	float grabsRotation = 0.0f;
	[Export(PropertyHint.Range, "-60,60,0.1")]
	public float GrabsRotation
	{
		get
		{
			return grabsRotation;
		}
		set
		{
			grabsRotation = value;
			OnGrabsUpdated();
		}
	}

	MeshInstance3D grab1;
	MeshInstance3D grab2;

	MeshInstance3D top;

	MeshInstance3D legsSidesMesh1;
	MeshInstance3D legsSidesMesh2;
	ShaderMaterial legsSidesMaterial;
	LegBars legsBars;
	Node3D ends;

	Vector3 prevScale;

	public ConveyorLeg()
	{
		SetNotifyLocalTransform(true);
	}

	void SetupReferences()
	{
		legsSidesMesh1 ??= GetNode<MeshInstance3D>("Sides/LegsSide1");
		legsSidesMesh2 ??= GetNode<MeshInstance3D>("Sides/LegsSide2");
		legsSidesMaterial ??= legsSidesMesh1.Mesh.SurfaceGetMaterial(0) as ShaderMaterial;
		legsSidesMesh1.Mesh.SurfaceSetMaterial(0, legsSidesMaterial);
		legsBars ??= GetNode<LegBars>("LegsBars");
		ends ??= GetNode<Node3D>("Ends");

		grab1 ??= GetNode<MeshInstance3D>("Ends/LegsTop1/LegsGrab1");
		grab2 ??= GetNode<MeshInstance3D>("Ends/LegsTop2/LegsGrab2");
	}

	Vector3 ConstrainScale()
	{
		float nodeScaleY = float.Max(1.0f, Scale.Y);
		float nodeScaleZ = Scale.Z;
		Vector3 newScale = new(1, nodeScaleY, nodeScaleZ);
		return newScale;
	}

	void OnScaleChanged()
	{
		if(Scale == prevScale) return;

		SetupReferences();

		if (legsSidesMaterial != null)
			legsSidesMaterial.SetShaderParameter("Scale", Scale.Y);

		if (legsBars != null && legsBars.ParentScale != Scale)
			legsBars.ParentScale = Scale;

		foreach (Node3D end in ends.GetChildren())
		{
			end.Scale = new Vector3(1 / Scale.X, 1 / Scale.Y, 1 / Scale.Z);
		}

		legsSidesMesh1.Scale = new Vector3(1 / Scale.X, 1, 1 / Scale.Z);
		legsSidesMesh2.Scale = new Vector3(1 / Scale.X, 1, 1 / Scale.Z);

		prevScale = Scale;
	}

	void OnGrabsUpdated()
	{
		SetupReferences();

		grab1?.SetRotationDegrees(new Vector3(0, 0, grabsRotation));
		grab2?.SetRotationDegrees(new Vector3(0, 0, -grabsRotation));

		grab1?.SetScale(Vector3.One);
		grab2?.SetScale(Vector3.One);
	}

	public override void _Notification(int what)
	{
		if (what == NotificationLocalTransformChanged)
		{
			Vector3 constrainedScale = ConstrainScale();
			if (constrainedScale != Scale)
			{
				Scale = constrainedScale;
			}
			OnScaleChanged();
		}
	}
}
