using Godot;

[Tool]
public partial class SideGuard : MeshInstance3D
{
	bool leftEnd = false;
	[Export]
	public bool LeftEnd
	{
		get
		{
			return leftEnd;
		}
		set
		{
			leftEnd = value;
			if (lEnd != null)
				lEnd.Visible = value;
		}
	}
	bool rightEnd = false;
	[Export]
	public bool RightEnd
	{
		get
		{
			return rightEnd;
		}
		set
		{
			rightEnd = value;
			if (rEnd != null)
				rEnd.Visible = value;
		}
	}
	float _length = 1f;
	[Export]
	float Length {
		get
		{
			return _length;
		}
		set
		{
			_length = value;
			if (_length != 0)
			{
				if (Scale.X != _length) Scale = new (_length, Scale.Y, Scale.Z);
				metalMaterial?.SetShaderParameter("Scale", _length);
				lEnd.Scale = new Vector3(1 / _length, 1, 1);
				rEnd.Scale = new Vector3(1 / _length, 1, 1);
			}
		}
	}

	ShaderMaterial _metalMaterial;
	ShaderMaterial metalMaterial {
		get
		{
			if (_metalMaterial != null) return _metalMaterial;
			var meshInstance = this;
			meshInstance.Mesh = meshInstance.Mesh.Duplicate() as Mesh;
			_metalMaterial = meshInstance.Mesh.SurfaceGetMaterial(0).Duplicate() as ShaderMaterial;
			meshInstance.Mesh.SurfaceSetMaterial(0, _metalMaterial);
			return _metalMaterial;
		}
	}

	Node3D _lEnd;
	Node3D lEnd { get => _lEnd ??= GetNodeOrNull<Node3D>("Ends/SideGuardEndL"); }
	Node3D _rEnd;
	Node3D rEnd { get => _rEnd ??= GetNodeOrNull<Node3D>("Ends/SideGuardEndR"); }

	public override void _EnterTree()
	{
		Length = Scale.X;
		SetNotifyLocalTransform(true);
		base._EnterTree();
	}

	public override void _Ready()
	{
		// Make sure material is initialized.
		_ = metalMaterial;
	}

	public override void _Notification(int what)
	{
		if (what == NotificationLocalTransformChanged)
		{
			Length = Scale.X;
		}
		base._Notification(what);
	}
}
