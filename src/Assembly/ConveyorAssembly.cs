using Godot;
using System.Linq;
using System.Collections.Generic;

[Tool]
public partial class ConveyorAssembly : TransformMonitoredNode3D, IConveyor
{
	#region Constants
	protected virtual float BaseLength => 1f;
	protected virtual float BaseWidth => 1f;
	protected virtual float BaseHeight => 2f;
	#endregion Constants

	#region Fields
	#region Fields / Nodes
	protected ConveyorAssemblyConveyors conveyors
	{
		get
		{
			if (!IsInstanceValid(_conveyors))
			{
				_conveyors = GetNodeOrNull<ConveyorAssemblyConveyors>("Conveyors");
				if (IsInstanceValid(_conveyors))
				{
					SetupConveyors();
				}
			}
			return _conveyors;
		}
	}
	private ConveyorAssemblyConveyors _conveyors;
	private ConveyorAssemblyChild rightSide => IsInstanceValid(_rightSide) ? _rightSide : _rightSide = GetNodeOrNull<ConveyorAssemblyChild>("RightSide");
	private ConveyorAssemblyChild _rightSide;
	private ConveyorAssemblyChild leftSide => IsInstanceValid(_leftSide) ? _leftSide : _leftSide = GetNodeOrNull<ConveyorAssemblyChild>("LeftSide");
	private ConveyorAssemblyChild _leftSide;
	private ConveyorAssemblyLegStands legStands => this.GetCachedValidNodeOrNull("LegStands", ref _legStands);
	private ConveyorAssemblyLegStands _legStands;
	#endregion Fields / Nodes
	private Transform3D conveyorsTransformPrev;

	#region Fields / Exported properties
	[ExportGroup("Conveyor", "Conveyor")]
	// Property is deprecated.
	private float ConveyorAngle
	{
		get
		{
			return conveyors?.GetAngle() ?? 0;
		}
		set
		{
			// Transfer the value to assembly rotation then zero out this property.
			// This is only expected to be called when instantiating old scenes.
			// It's not idepotent anymore, so don't use it yourself!
			conveyors?.SetAngle(0);
			if (value == 0) return;
			Vector3 rotation = Transform.Basis.Orthonormalized().GetEuler(EulerOrder.Yzx);
			Vector3 scale = Transform.Basis.Scale;
			Vector3 newRot = new Vector3(rotation.X, rotation.Y, rotation.Z + value);
			Basis newBasis = Basis.FromEuler(newRot, EulerOrder.Yzx).Transposed().Scaled(scale).Transposed();
			Transform = new Transform3D(newBasis, Transform.Origin);
		}
	}

	// Deprecated: No longer has any practical purpose.
	[Export]
	private bool ConveyorAutomaticLength
	{
		get => _conveyorAutomaticLength;
		set
		{
			if (value == _conveyorAutomaticLength) return;
			_conveyorAutomaticLength = value;
			conveyors?.SetNeedsUpdate(true);
			NotifyPropertyListChanged();
		}
	}
	private bool _conveyorAutomaticLength = true;


	public float Speed { get => BeltConveyorSpeed; set
		{
			BeltConveyorSpeed = value;
			RollerConveyorSpeed = value;
		}
	}

	// This rest of this section is for properties proxied to the conveyor parts.
	[ExportSubgroup("Comms")]
	[Export]
	public bool EnableComms {
		get
		{
			// We're going to assume that the first child is a conveyor part.
			// This could be improved to be more robust, but should work most of the time.
			Node conveyor = conveyors?.GetChildOrNull<Node>(0);
			if (IsConveyor(conveyor))
			{
				return (conveyor as IComms).EnableComms;
			}
			// If conveyor is null, it's more likely because `conveyors` isn't available yet.
			return false;
		}
		set
		{
			if (conveyors == null)
			{
				return;
			}
			foreach (Node conveyor in conveyors.GetChildren())
			{
				if (IsConveyor(conveyor))
				{
					(conveyor as IComms).EnableComms = value;
				}
			}
			NotifyPropertyListChanged();
		}
	}

	[Export]
	public string Tag {
		get
		{
			Node conveyor = conveyors?.GetChildOrNull<Node>(0);
			if (IsConveyor(conveyor))
			{
				return (conveyor as IComms).Tag;
			}
			return null;
		}
		set
		{
			if (conveyors == null)
			{
				return;
			}
			foreach (Node conveyor in conveyors.GetChildren())
			{
				if (IsConveyor(conveyor))
				{
					(conveyor as IComms).Tag = value;
				}
			}
		}
	}

	[Export]
	public int UpdateRate {
		get
		{
			Node conveyor = conveyors?.GetChildOrNull<Node>(0);
			if (IsConveyor(conveyor))
			{
				return (conveyor as IComms).UpdateRate;
			}
			return 100;
		}
		set
		{
			if (conveyors == null)
			{
				return;
			}
			foreach (Node conveyor in conveyors.GetChildren())
			{
				if (IsConveyor(conveyor))
				{
					(conveyor as IComms).UpdateRate = value;
				}
			}
		}
	}
	[ExportSubgroup("BeltConveyor", "BeltConveyor")]
	[Export]
	public Color BeltConveyorBeltColor {
		get
		{
			Node conveyor = conveyors?.GetChildOrNull<Node>(0);
			return (conveyor as IBeltConveyor)?.BeltColor ?? new Color(1, 1, 1, 1);
		}
		set
		{
			if (conveyors == null)
			{
				return;
			}
			foreach (Node node in conveyors.GetChildren())
			{
				if (node is IBeltConveyor conveyor)
				{
					conveyor.BeltColor = value;
				}
			}
		}
	}

	[Export]
	public IBeltConveyor.ConvTexture BeltConveyorBeltTexture {
		get
		{
			Node conveyor = conveyors?.GetChildOrNull<Node>(0);
			if (IsConveyor(conveyor))
			{
				return (conveyor as IBeltConveyor)?.BeltTexture ?? IBeltConveyor.ConvTexture.Standard;
			}
			return IBeltConveyor.ConvTexture.Standard;
		}
		set
		{
			if (conveyors == null)
			{
				return;
			}
			foreach (Node node in conveyors.GetChildren())
			{
				if (node is IBeltConveyor conveyor)
				{
					conveyor.BeltTexture = value;
				}
			}
		}
	}

	[Export(PropertyHint.None, "suffix:m/s")]
	public float BeltConveyorSpeed {
		get
		{
			IBeltConveyor conveyor = conveyors?.GetChildOrNull<IBeltConveyor>(0);
			return conveyor?.Speed ?? 2.0f;
		}
		set
		{
			if (conveyors == null)
			{
				return;
			}
			foreach (Node node in conveyors.GetChildren())
			{
				if (node is IBeltConveyor conveyor)
				{
					conveyor.Speed = value;
				}
			}
		}
	}
	[Export] // See _ValidateProperty for PropertyHint
	public float BeltConveyorReferenceDistance {
		get
		{
			CurvedBeltConveyor conveyor = conveyors?.GetChildOrNull<CurvedBeltConveyor>(0);
			return conveyor?.ReferenceDistance ?? 0.5f;
		}
		set
		{
			if (conveyors == null)
			{
				return;
			}
			foreach (Node node in conveyors.GetChildren())
			{
				if (node is CurvedBeltConveyor conveyor)
				{
					conveyor.ReferenceDistance = value;
				}
			}
		}
	}

	[Export]
	public PhysicsMaterial BeltConveyorBeltPhysicsMaterial {
		get
		{
			IBeltConveyor conveyor = conveyors?.GetChildOrNull<IBeltConveyor>(0);
			return conveyor?.BeltPhysicsMaterial;
		}
		set
		{
			if (conveyors == null)
			{
				return;
			}
			foreach (Node node in conveyors.GetChildren())
			{
				if (node is IBeltConveyor conveyor)
				{
					conveyor.BeltPhysicsMaterial = value;
				}
			}
		}
	}

	[ExportSubgroup("RollerConveyor", "RollerConveyor")]
	[Export(PropertyHint.None, "suffix:m/s")]
	public float RollerConveyorSpeed {
		get
		{
			IRollerConveyor conveyor = conveyors?.GetChildOrNull<IRollerConveyor>(0);
			return conveyor?.Speed ?? 2.0f;
		}
		set
		{
			if (conveyors == null)
			{
				return;
			}
			foreach (Node node in conveyors.GetChildren())
			{
				if (node is IRollerConveyor conveyor)
				{
					conveyor.Speed = value;
				}
			}
		}
	}
	[Export] // See _ValidateProperty for PropertyHint
	public float RollerConveyorReferenceDistance {
		get
		{
			CurvedRollerConveyor conveyor = conveyors?.GetChildOrNull<CurvedRollerConveyor>(0);
			return conveyor?.ReferenceDistance ?? 0.5f;
		}
		set
		{
			if (conveyors == null)
			{
				return;
			}
			foreach (Node node in conveyors.GetChildren())
			{
				if (node is CurvedRollerConveyor conveyor)
				{
					conveyor.ReferenceDistance = value;
				}
			}
		}
	}
	[Export]
	public float RollerConveyorSkewAngle {
		get
		{
			RollerConveyor conveyor = conveyors?.GetChildOrNull<RollerConveyor>(0);
			return conveyor?.SkewAngle ?? 0.0f;
		}
		set
		{
			if (conveyors == null)
			{
				return;
			}
			foreach (Node node in conveyors.GetChildren())
			{
				if (node is RollerConveyor conveyor)
				{
					conveyor.SkewAngle = value;
				}
			}
		}
	}

	[ExportGroup("Side Guards", "SideGuards")]
	[Export]
	public bool SideGuardsLeftSide
	{
		get => _sideGuardsLeftSide;
		set
		{
			_sideGuardsLeftSide = value;
			UpdateSide(false);
		}
	}
	private bool _sideGuardsLeftSide = true;
	[Export]
	public bool SideGuardsRightSide
	{
		get => _sideGuardsRightSide;
		set
		{
			_sideGuardsRightSide = value;
			UpdateSide(true);
		}
	}
	private bool _sideGuardsRightSide = true;
	// This only exists to give us a single checkbox for CurvedConveyorAssembly, which doesn't have separate left and right side guard models.
	// We hide it in the editor by default.
	[Export]
	public bool SideGuardsBothSides
	{
		get => SideGuardsLeftSide && SideGuardsRightSide;
		set
		{
			SideGuardsLeftSide = value;
			SideGuardsRightSide = value;
		}
	}
	[Export]
	public Godot.Collections.Array<SideGuardGap> SideGuardsGaps
	{
		get => _sideGuardsGaps;
		set
		{
			// Unsubscribe from previous gaps. They may be replaced with new ones.
			foreach (SideGuardGap gap in _sideGuardsGaps)
			{
				if (gap == null)
				{
					// Shouldn't be possible since all nulls should have been replaced by instances.
					continue;
				}
				gap.Disconnect(Resource.SignalName.Changed, new Callable(this, MethodName.UpdateSides));
			}

			// Workaround for faulty duplicate behavior in the editor.
			// See issue #74918.
			if (_sideGuardsGaps.Count == 0) {
				// Assume that we're initializing for the first time.
				foreach (SideGuardGap gap in value)
				{
					// Any gaps we see in the new array possibly came from an original that this instance is a duplicate of.
					// There's no way to know for sure.
					// Make all the gaps unique to this instance to prevent editing the originals.
					_sideGuardsGaps.Add(gap?.Duplicate(true) as SideGuardGap);
				}
			} else {
				// If we're not initializing, avoid making unnecessary duplicates.
				_sideGuardsGaps = value;
			}

			// Replace null with a new gap so users don't have to do this by hand.
			for (int i = 0; i < _sideGuardsGaps.Count; i++)
			{
				_sideGuardsGaps[i] ??= new SideGuardGap();
			}

			// Subscribe to ensure that side guards update whenever gaps change.
			foreach (SideGuardGap gap in _sideGuardsGaps)
			{
				// null gaps shouldn't be possible since we just replaced them above.
				gap.Connect(Resource.SignalName.Changed, new Callable(this, MethodName.UpdateSides));
			}

			// Update side guards to account for added or removed gaps.
			UpdateSides();
		}
	}
	private Godot.Collections.Array<SideGuardGap> _sideGuardsGaps = new();
	[Export]
	public PackedScene SideGuardsModelScene
	{
		get => _sideGuardsModelScene;
		set
		{
			bool hasChanged = _sideGuardsModelScene != value;
			_sideGuardsModelScene = value;
			if (hasChanged) {
				UpdateSides();
			}
		}
	}
	private PackedScene _sideGuardsModelScene = GD.Load<PackedScene>("res://parts/SideGuard.tscn");

	[ExportGroup("Leg Stands", "AutoLegStands")]
	[ExportSubgroup("Floor", "AutoLegStandsFloor")]
	[Export(PropertyHint.None, "suffix:m")]
	public float AutoLegStandsFloorOffset {
		get => legStands?.GetFloorOffset() ?? 0;
		set
		{
			_autoLegStandsFloorOffset = value;
			legStands?.SetFloorOffset(value);
		}
	}
	float _autoLegStandsFloorOffset = float.NaN;

	[Export]
	public bool AutoLegStandsFloorOffsetLock
	{
		get => legStands?.FloorOffsetLock ?? false;
		set => legStands?.SetFloorOffsetLock(value);
	}

	[Export(PropertyHint.None, "radians_as_degrees")]
	public float AutoLegStandsFloorAngle
	{
		// Angle is in parent's space.
		get => legStands?.GetFloorAngle() ?? 0f;
		set => legStands?.SetFloorAngle(value);
	}

	[ExportSubgroup("Interval Legs", "AutoLegStandsIntervalLegs")]
	[Export]
	public bool AutoLegStandsIntervalLegsEnabled {
		get => _autoLegStandsIntervalLegsEnabled;
		set => SetLegStandsNeedsUpdateIfChanged(value, ref _autoLegStandsIntervalLegsEnabled);
	}
	bool _autoLegStandsIntervalLegsEnabled = true;

	[Export(PropertyHint.Range, "0.5,10,or_greater,suffix:m")]
	public float AutoLegStandsIntervalLegsInterval {
		get => _autoLegStandsIntervalLegsInterval;
		set => SetLegStandsNeedsUpdateIfChanged(value, ref _autoLegStandsIntervalLegsInterval);
	}
	private float _autoLegStandsIntervalLegsInterval = 2f;

	[Export(PropertyHint.Range, "-5,5,or_less,or_greater,suffix:m")]
	public float AutoLegStandsIntervalLegsOffset {
		get => legStands?.GetIntervalLegsOffset() ?? 0;
		set => legStands?.SetIntervalLegsOffset(value);
	}

	[ExportSubgroup("End Legs", "AutoLegStandsEndLeg")]
	[Export]
	public bool AutoLegStandsEndLegFront {
		get => _autoLegStandsEndLegFront;
		set => SetLegStandsNeedsUpdateIfChanged(value, ref _autoLegStandsEndLegFront);
	}
	private bool _autoLegStandsEndLegFront = true;
	[Export]
	public bool AutoLegStandsEndLegRear {
		get => _autoLegStandsEndLegRear;
		set => SetLegStandsNeedsUpdateIfChanged(value, ref _autoLegStandsEndLegRear);
	}
	private bool _autoLegStandsEndLegRear = true;

	[ExportSubgroup("Placement Margins", "AutoLegStandsMargin")]
	[Export(PropertyHint.Range, "0,1,or_less,or_greater,suffix:m")]
	public float AutoLegStandsMarginEnds
	{
		get => _autoLegStandsMarginEnds;
		set
		{
			if (!SetLegStandsNeedsUpdateIfChanged(value, ref _autoLegStandsMarginEnds)) return;
			legStands?.UpdateLegStandCoverage();
		}
	}
	private float _autoLegStandsMarginEnds = 0.2f;
	[Export(PropertyHint.Range, "0.5,5,or_greater,suffix:m")]
	public float AutoLegStandsMarginEndLegs {
		get => _autoLegStandsMarginEndLegs;
		set => SetLegStandsNeedsUpdateIfChanged(value, ref _autoLegStandsMarginEndLegs);
	}
	private float _autoLegStandsMarginEndLegs = 0.5f;

	[ExportSubgroup("Leg Model", "AutoLegStandsModel")]
	[Export(PropertyHint.None, "suffix:m")]
	public float AutoLegStandsModelGrabsOffset {
		get => _autoLegStandsModelGrabsOffset;
		set
		{
			if (!SetLegStandsNeedsUpdateIfChanged(value, ref _autoLegStandsModelGrabsOffset)) return;
			legStands?.UpdateLegStandsHeightAndVisibility();
			legStands?.UpdateLegStandCoverage();
		}
	}
	private float _autoLegStandsModelGrabsOffset = 0.632f;

	[Export]
	public PackedScene AutoLegStandsModelScene {
		get => _autoLegStandsModelScene;
		set => SetLegStandsNeedsUpdateIfChanged(value, ref _autoLegStandsModelScene);
	}
	private PackedScene _autoLegStandsModelScene = GD.Load<PackedScene>("res://parts/ConveyorLegBC.tscn");
	#endregion Fields / Exported properties

	#region Fields / Length, Width, Height, Basis
	private Basis _cachedBasis = Basis.Identity;
	private Vector3 _cachedScale = Vector3.One;

	private Basis _basisPrev = Basis.Identity;
	private Vector3 _scalePrev = Vector3.One;

	private float _length;
	public float Length
	{
		get => _length;
		set => SetLength(value);
	}

	public void SetLength(float length)
	{
		if (_length == length) return;
		_length = length;
	}

	private float _width;
	public float Width
	{
		get => _width;
		set => SetWidth(value);
	}

	public void SetWidth(float width)
	{
		if (_width == width) return;
		_width = width;
	}

	private float _height;
	public float Height
	{
		get => _height;
		set => SetHeight(value);
	}

	public void SetHeight(float height)
	{
		if (_height == height) return;
		_height = height;
	}
	#endregion Fields / Length, Width, Height, Basis

	#region Fields / Property method overrides
	public override void _ValidateProperty(Godot.Collections.Dictionary property) {
		StringName propertyName = property["name"].AsStringName();

		// Hide this property as it's only useful for CurvedConveyorAssembly; it clutters the UI otherwise.
		if (propertyName == PropertyName.SideGuardsBothSides) {
			// We don't even want it stored. SideGuardsLeftSide and SideGuardsRightSide are the source of truth.
			property["usage"] = (int) PropertyUsageFlags.None;
		}
		// These only have an effect if EnableComms is true.
		else if (propertyName == PropertyName.UpdateRate || propertyName == PropertyName.Tag)
		{
			property["usage"] = (int)(EnableComms ? PropertyUsageFlags.Default : PropertyUsageFlags.NoEditor);
		}
		// Only show if a IBeltConveyor is present.
		else if (propertyName == PropertyName.BeltConveyorBeltColor
			|| propertyName == PropertyName.BeltConveyorBeltTexture
			|| propertyName == PropertyName.BeltConveyorSpeed
			|| propertyName == PropertyName.BeltConveyorBeltPhysicsMaterial) {
			property["usage"] = (int)(conveyors?.GetChildOrNull<IBeltConveyor>(0) != null ? PropertyUsageFlags.Default : PropertyUsageFlags.NoEditor);
		}
		// Only show if a IRollerConveyor is present.
		else if (propertyName == PropertyName.RollerConveyorSpeed) {
			property["usage"] = (int)(conveyors?.GetChildOrNull<IRollerConveyor>(0) != null ? PropertyUsageFlags.Default : PropertyUsageFlags.NoEditor);
		}
		// Only show if a RollerConveyor is present. (CurvedRollerConveyors don't have skew angles.)
		else if (propertyName == PropertyName.RollerConveyorSkewAngle) {
			property["usage"] = (int)(conveyors?.GetChildOrNull<RollerConveyor>(0) != null ? PropertyUsageFlags.Default : PropertyUsageFlags.NoEditor);
		}
		// Only show if a CurvedBeltConveyor is present.
		else if (propertyName == PropertyName.BeltConveyorReferenceDistance) {
			CurvedBeltConveyor curvedBeltConveyor = conveyors?.GetChildOrNull<CurvedBeltConveyor>(0);
			property["usage"] = (int)(curvedBeltConveyor != null ? PropertyUsageFlags.Default : PropertyUsageFlags.None);
			// Copy properties info from the existing object.
			// It changes depending on conveyor width
			var props = curvedBeltConveyor?.GetPropertyList()?.Where(prop => {
				prop.TryGetValue("name", out Variant name);
				return CurvedBeltConveyor.PropertyName.ReferenceDistance.Equals(name.AsStringName());
			})?.First();
			if (props != null) {
				props.TryGetValue("hint", out Variant hint);
				props.TryGetValue("hint_string", out Variant hintString);
				property["hint"] = hint;
				property["hint_string"] = hintString;
				// TODO figure out a good way to subscribe to further property hint changes.
			}
		}
		// Only show if a CurvedRollerConveyor is present.
		else if (propertyName == PropertyName.RollerConveyorReferenceDistance) {
			CurvedRollerConveyor curvedRollerConveyor = conveyors?.GetChildOrNull<CurvedRollerConveyor>(0);
			property["usage"] = (int)(curvedRollerConveyor != null ? PropertyUsageFlags.Default : PropertyUsageFlags.None);
			// Copy properties info from the existing object.
			// It changes depending on conveyor width
			var props = curvedRollerConveyor?.GetPropertyList()?.Where(prop => {
				prop.TryGetValue("name", out Variant name);
				return CurvedRollerConveyor.PropertyName.ReferenceDistance.Equals(name.AsStringName());
			})?.First();
			if (props != null) {
				props.TryGetValue("hint", out Variant hint);
				props.TryGetValue("hint_string", out Variant hintString);
				property["hint"] = hint;
				property["hint_string"] = hintString;
				// TODO figure out a good way to subscribe to further property hint changes.
			}
		}
		else if (propertyName == PropertyName.ConveyorAutomaticLength)
		{
			// Hide deprecated property.
			// If changed, show it anyway to allow users to restore its default value.
			if (ConveyorAutomaticLength)
			{
				property["usage"] = (int)PropertyUsageFlags.NoEditor;
			}
		}
		else
		{
			base._ValidateProperty(property);
		}
	}

	public override bool _PropertyCanRevert(StringName property) {
		return property == PropertyName.SideGuardsBothSides
			|| property == PropertyName.UpdateRate
			|| property == PropertyName.BeltConveyorBeltColor
			|| property == PropertyName.BeltConveyorSpeed
			|| property == PropertyName.RollerConveyorSpeed
			|| property == PropertyName.BeltConveyorReferenceDistance
			|| property == PropertyName.RollerConveyorReferenceDistance
			|| property == PropertyName.AutoLegStandsFloorOffset
			|| base._PropertyCanRevert(property);
	}

	public override Variant _PropertyGetRevert(StringName property) {
		if (property == PropertyName.SideGuardsBothSides) {
			return true;
		}
		if (property == PropertyName.UpdateRate) {
			return 100;
		}
		if (property == PropertyName.BeltConveyorBeltColor) {
			return new Color(1, 1, 1, 1);
		}
		if (property == PropertyName.BeltConveyorSpeed
			|| property == PropertyName.RollerConveyorSpeed) {
			return 2.0f;
		}
		if (property == PropertyName.BeltConveyorReferenceDistance
			|| property == PropertyName.RollerConveyorReferenceDistance) {
			return 0.5f;
		}
		if (property == PropertyName.AutoLegStandsFloorOffset)
		{
			return -2.0f;
		}
		return base._PropertyGetRevert(property);
	}
	#endregion Fields / Property method overrides
	#endregion Fields

	#region constructor, _Ready, and _PhysicsProcess
	public ConveyorAssembly()
	{
		BasisChanged += void (value) => _cachedBasis = value;
		ScaleChanged += void (value) => _cachedScale = value;
		ScaleXChanged += void (value) => SetLength(value * BaseLength);
		ScaleZChanged += void (value) => SetWidth(value * BaseWidth);
		ScaleYChanged += void (value) => SetHeight(value * BaseHeight);

		// Initialize with default values
		Length = BaseLength;
		Width = BaseWidth;
		Height = BaseHeight;
		// If necessary, trigger signals to set new values
		SetTransform(Transform);

		_basisPrev = _cachedBasis;
		TransformChanged += void (_) => PreventAllChildScaling();
	}

	public override void _Ready()
	{
		UpdateSides();
		PreventAllChildScaling();
	}

	public override void _Notification(int what)
	{
		if (what == NotificationSceneInstantiated && !float.IsNaN(_autoLegStandsFloorOffset))
		{
			legStands?.SetFloorOffset(_autoLegStandsFloorOffset);
		}
		base._Notification(what);
	}
	#endregion constructor, _Ready, and _PhysicsProcess

	#region Decouple assembly scale from child scale
	private void PreventAllChildScaling() {
		foreach (Node child in GetChildren()) {
			if (child is ConveyorAssemblyChild assemblyChild) {
				assemblyChild.OnAssemblyTransformChanged();
			} else if (child is Node3D child3D) {
				PreventChildScaling(child3D);
			}
		}
		_basisPrev = Basis;
	}

	/**
	 * Counteract the scaling of child nodes as the parent node scales.
	 *
	 * This is a hack to allow us to decouple the scaling of the assembly from the scaling of its parts.
	 *
	 * Child nodes will appear not to scale, but actually, scale inversely to the parent.
	 * Parent scale will still affect the child's position, but not its apparent rotation.
	 *
	 * The downside is the child's scale will be appear locked to (1, 1, 1).
	 * This is why all of our scalable parts aren't direct children of the assembly.
	 *
	 * @param child The child node to prevent scaling.
	 */
	private void PreventChildScaling(Node3D child) {
		Transform3D result = PreventChildScaling(child.Transform, _basisPrev);
		if (child.Transform != result) {
			child.Transform = result;
		}
	}

	private Transform3D PreventChildScaling(Transform3D childTransform, Basis basisPrev) {
		// The child transform without the effects of the parent's scale.
		var apparentChildTransform = ConveyorAssemblyChild.LocalToApparent(basisPrev, childTransform);

		// Remove any remaining scale. This effectively locks child's scale to (1, 1, 1).
		apparentChildTransform.Basis = apparentChildTransform.Basis.Orthonormalized();

		// Reapply inverse parent scaling to child.
		var newChildTransform = ConveyorAssemblyChild.ApparentToLocal(Basis, apparentChildTransform);
		return newChildTransform;
	}
	#endregion Decouple assembly scale from child scale

	private bool SetLegStandsNeedsUpdateIfChanged<T>(T newVal, ref T cachedVal)
	{
		bool changed = !EqualityComparer<T>.Default.Equals(newVal, cachedVal);
		if (changed)
		{
			cachedVal = newVal;
			legStands?.SetNeedsUpdate(true);
		}
		return changed;
	}

	protected override Transform3D ConstrainTransform(Transform3D transform)
	{
		Vector3 rotation = transform.Basis.Orthonormalized().GetEuler(EulerOrder.Yzx);
		if (Mathf.IsZeroApprox(rotation.X))
		{
			return transform;
		}
		Vector3 scale = transform.Basis.Scale;
		Vector3 newRot = new Vector3(0f, rotation.Y, rotation.Z);
		Basis newBasis = Basis.FromEuler(newRot, EulerOrder.Yzx).Transposed().Scaled(scale).Transposed();
		return new Transform3D(newBasis, transform.Origin);
	}
}
