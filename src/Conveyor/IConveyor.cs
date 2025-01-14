using Godot;
using System;

public interface IConveyor : IComms
{
	public float Speed { get; set; }
	public Node3D AsNode3D() { return this as Node3D; }
}
