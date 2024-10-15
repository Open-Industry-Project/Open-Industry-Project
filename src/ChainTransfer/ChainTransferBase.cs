using Godot;
using System;

[Tool]
public partial class ChainTransferBase : Node3D
{
	bool active = false;
	public bool Active
	{
		get
		{
			return active;
		}
		set
		{
			active = value;
			if (active) Up();
			else Down();
		}
	}

	public float Speed { get; set; }

	StaticBody3D containerBody;
	Node3D bas;
	Node3D container;
	Node3D chain;
	float childrenInitialY;
	float activePos = 0.095f;

	StaticBody3D sb;
	Vector3 origin;

	bool running = false;

	int chainScale = 32;
	int chainEndScale = 6;

	MeshInstance3D chainMesh;
	MeshInstance3D chainEndLMesh;
	MeshInstance3D chainEndRMesh;

	ShaderMaterial chainMaterial;
	ShaderMaterial chainEndLMaterial;
	ShaderMaterial chainEndRMaterial;

	double chainPosition = 0.0;
	double chainEndPosition = 0.0;

	ChainTransfer owner;

	void InitMesh(ref MeshInstance3D mesh, String path, ref ShaderMaterial material)
	{
		mesh = GetNode<MeshInstance3D>(path);
		mesh.Mesh = mesh.Mesh.Duplicate() as Mesh;
		material = mesh.Mesh.SurfaceGetMaterial(0).Duplicate() as ShaderMaterial;
		mesh.Mesh.SurfaceSetMaterial(0, material);
	}

	void SetChainPosition(ShaderMaterial material, double pos)
	{
		if (material != null && Speed != 0)
		{
			material.SetShaderParameter("ChainPosition", pos * Mathf.Sign(Speed));
		}
	}

	public override void _Ready()
	{
		containerBody = GetNode<StaticBody3D>("ContainerBody");
		bas = GetNode<Node3D>("Base");
		container = GetNode<Node3D>("Container");
		chain = GetNode<Node3D>("Chain");

		childrenInitialY = container.Position.Y;

		sb = GetNode<StaticBody3D>("Chain/StaticBody3D");
		origin = sb.Position;

		InitMesh(ref chainMesh, "Chain", ref chainMaterial);
		InitMesh(ref chainEndLMesh, "Chain/ChainL", ref chainEndLMaterial);
		InitMesh(ref chainEndRMesh, "Chain/ChainR", ref chainEndRMaterial);

		chainPosition = 0.0;
		chainEndPosition = 0.0;
		SetChainPosition(chainMaterial, 0);
		SetChainPosition(chainEndLMaterial, 0);
		SetChainPosition(chainEndRMaterial, 0);

		owner = GetParent() as ChainTransfer;
	}

	public override void _PhysicsProcess(double delta)
	{
		if (running)
		{
			var localLeft = sb.GlobalTransform.Basis.X.Normalized();
			var velocity = localLeft * Speed;
			sb.ConstantLinearVelocity = velocity;
			sb.Position = origin;

			sb.Rotation = Vector3.Zero;
			sb.Scale = new Vector3(1, 1, 1);

			if (chainMaterial != null && owner != null)
			{
				chainPosition += (Mathf.Abs(Speed) / (Mathf.Round(owner.Scale.X * chainScale))) * delta;
				if (chainPosition > 1.0) {
					chainPosition = chainPosition - 1.0;
				}
				chainEndPosition += (Mathf.Abs(Speed) / chainEndScale) * delta;
				if (chainEndPosition > 1.0) {
					chainEndPosition = chainEndPosition - 1.0;
				}
				SetChainPosition(chainMaterial, chainPosition);
				SetChainPosition(chainEndLMaterial, chainEndPosition);
				SetChainPosition(chainEndRMaterial, chainEndPosition);
			}
		}

		if (chainMaterial != null && owner != null)
			chainMaterial.SetShaderParameter("Scale", owner.Scale.X * chainScale);

		ScaleChildren(bas);
		ScaleChildren(container);
		ScaleChildren(chain);
	}

	public void TurnOn()
	{
		running = true;
	}

	public void TurnOff()
	{
		running = false;

		chainPosition = 0.0;
		chainEndPosition = 0.0;
		SetChainPosition(chainMaterial, 0);
		SetChainPosition(chainEndLMaterial, 0);
		SetChainPosition(chainEndRMaterial, 0);

		sb.Position = Vector3.Zero;
		sb.Rotation = Vector3.Zero;
		sb.ConstantLinearVelocity = Vector3.Zero;
	}

	// Moves the chain up
	void Up()
	{
		Tween tween = GetTree().CreateTween().SetEase(0).SetParallel(); // Set EaseIn
		tween.TweenProperty(containerBody, "position", new Vector3(containerBody.Position.X, childrenInitialY + activePos, containerBody.Position.Z), 0.15f);
		tween.TweenProperty(container, "position", new Vector3(container.Position.X, childrenInitialY + activePos, container.Position.Z), 0.15f);
		tween.TweenProperty(chain, "position", new Vector3(chain.Position.X, childrenInitialY + activePos, chain.Position.Z), 0.15f);
	}

	// Moves the chain down
	void Down()
	{
		Tween tween = GetTree().CreateTween().SetEase(0).SetParallel(); // Set EaseIn
		tween.TweenProperty(containerBody, "position", new Vector3(containerBody.Position.X, childrenInitialY, containerBody.Position.Z), 0.15f);
		tween.TweenProperty(container, "position", new Vector3(container.Position.X, childrenInitialY, container.Position.Z), 0.15f);
		tween.TweenProperty(chain, "position", new Vector3(chain.Position.X, childrenInitialY, chain.Position.Z), 0.15f);
	}

	void ScaleChildren(Node3D nodesContainer)
	{
		if (owner == null) return;
		foreach (Node3D node in nodesContainer.GetChildren())
		{
			if (nodesContainer.Name == "Chain" && node is StaticBody3D) continue;
			node.Scale = new Vector3(1 / owner.Scale.X, 1, 1);
		}
	}
}
