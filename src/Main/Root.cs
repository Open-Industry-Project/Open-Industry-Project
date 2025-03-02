using Godot;
using Godot.Collections;
using libplctag;
using libplctag.DataTypes;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Opc.Ua.Client;
using Opc.Ua;
using Opc.Ua.Configuration;

[Tool]
public partial class Root : Node3D
{
	[Signal]
	public delegate void SimulationStartedEventHandler();
	[Signal]
	public delegate void SimulationSetPausedEventHandler(bool paused);
	[Signal]
	public delegate void SimulationEndedEventHandler();

	[Signal]
	public delegate void ValueChangedEventHandler(string tag, Godot.Variant value);

	public bool simulationRunning = false;

	public bool simulationPaused = false;

	private bool _start = false;

	private bool keyHeld = false;

	private bool use = false;

	public bool Start
	{
		get
		{
			return _start;
		}
		set
		{
			_start = value;

			if (_start)
			{
				EmitSignal(SignalName.SimulationStarted);
				simulationRunning = true;
			}
			else
			{
				bool_tags.Clear();
				int_tags.Clear();
				float_tags.Clear();
				opc_tags.Clear();
				EmitSignal(SignalName.SimulationEnded);
				simulationRunning = false;
			}
		}
	}


	private Protocols _protocol;

	[Export]
	public Protocols Protocol
	{
		get => _protocol;
		set
		{
			_protocol = value;
			NotifyPropertyListChanged();
		}
	}

	[Export]
	private string Gateway { get; set; }

	[Export]
	private string Path { get; set; }

	[Export]

	private PlcType PlcType { get; set; } = PlcType.ControlLogix;

	[Export]

	private string EndPoint { get; set; }

	readonly System.Collections.Generic.Dictionary<Guid, Tag<RealPlcMapper, float>> float_tags = new();
	readonly System.Collections.Generic.Dictionary<Guid, Tag<BoolPlcMapper, bool>> bool_tags = new();
	readonly System.Collections.Generic.Dictionary<Guid, Tag<DintPlcMapper, int>> int_tags = new();
	readonly System.Collections.Generic.Dictionary<Guid, string> opc_tags = new();

	public Array<Godot.Node> selectedNodes = [];

	public Session session;

	Subscription subscription;

	EditorSettings editorSettings = new();

	public enum Protocols
	{
		opc_ua,
		ab_eip,
		modbus_tcp,
	}

	public enum DataType
	{
		Bool,
		Int,
		Float
	}

	public override void _ValidateProperty(Godot.Collections.Dictionary property)
	{
		string propertyName = property["name"].AsStringName();

		if (propertyName == PropertyName.EndPoint)
		{
			property["usage"] = (int)(Protocol == Protocols.opc_ua ? PropertyUsageFlags.Default : PropertyUsageFlags.NoEditor);
		}
		else if (propertyName == PropertyName.Gateway || propertyName == PropertyName.Path || propertyName == PropertyName.PlcType)
		{
			property["usage"] = (int)(Protocol == Protocols.opc_ua ? PropertyUsageFlags.NoEditor : PropertyUsageFlags.Default);
		}
	}
	private void OpcConnect()
	{
		var config = new ApplicationConfiguration()
		{
			ApplicationName = "Open Industry Project",
			ApplicationUri = Utils.Format(@"urn:{0}:Open Industry Project", System.Net.Dns.GetHostName()),
			ApplicationType = ApplicationType.Client,
			SecurityConfiguration = new SecurityConfiguration
			{
				ApplicationCertificate = new CertificateIdentifier { StoreType = @"Directory", StorePath = @"%CommonApplicationData%\OPC Foundation\CertificateStores\MachineDefault", SubjectName = "Open Industry Project" },
				TrustedIssuerCertificates = new CertificateTrustList { StoreType = @"Directory", StorePath = @"%CommonApplicationData%\OPC Foundation\CertificateStores\UA Certificate Authorities" },
				TrustedPeerCertificates = new CertificateTrustList { StoreType = @"Directory", StorePath = @"%CommonApplicationData%\OPC Foundation\CertificateStores\UA Applications" },
				RejectedCertificateStore = new CertificateTrustList { StoreType = @"Directory", StorePath = @"%CommonApplicationData%\OPC Foundation\CertificateStores\RejectedCertificates" },
				AutoAcceptUntrustedCertificates = true
			},
			TransportConfigurations = new TransportConfigurationCollection(),
			TransportQuotas = new TransportQuotas { OperationTimeout = 15000 },
			ClientConfiguration = new ClientConfiguration { DefaultSessionTimeout = 60000 },
			TraceConfiguration = new TraceConfiguration()
		};
		config.Validate(ApplicationType.Client).GetAwaiter().GetResult();

		if (config.SecurityConfiguration.AutoAcceptUntrustedCertificates)
		{
			config.CertificateValidator.CertificateValidation += (s, e) => { e.Accept = (e.Error.StatusCode == StatusCodes.BadCertificateUntrusted); };
		}

		var application = new ApplicationInstance
		{
			ApplicationName = "Open Industry Project",
			ApplicationType = ApplicationType.Client,
			ApplicationConfiguration = config
		};

		application.CheckApplicationInstanceCertificate(false, 2048).GetAwaiter().GetResult();

		EndpointDescription endpointDescription = CoreClientUtils.SelectEndpoint(EndPoint, false);
		EndpointConfiguration endpointConfiguration = EndpointConfiguration.Create(config);
		ConfiguredEndpoint endpoint = new(null, endpointDescription, endpointConfiguration);

		bool updateBeforeConnect = false;

		bool checkDomain = false;

		string sessionName = config.ApplicationName;

		uint sessionTimeout = 60000;

		List<string> preferredLocales = null;

		session = Session.Create(
					config,
					endpoint,
					updateBeforeConnect,
					checkDomain,
					sessionName,
					sessionTimeout,
					new UserIdentity(),
					preferredLocales
				).Result;

		subscription = new Subscription(session.DefaultSubscription)
		{
			DisplayName = "OIP",
			PublishingEnabled = true,
			PublishingInterval = 100
		};

		session.AddSubscription(subscription);

		subscription.Create();

	}

	public virtual void MonitoredItemHandler(MonitoredItem item, MonitoredItemNotificationEventArgs args)
	{
		try
		{
			var value = item.DequeueValues()[0].Value;

			Godot.Variant variantValue = false;

			if (value is float f)
			{
				variantValue = Godot.Variant.From(f);
			}
			else if (value is int i)
			{
				variantValue = Godot.Variant.From(i);
			}
			else if (value is bool b)
			{
				variantValue = Godot.Variant.From(b);
			}
			else if (value is double d)
			{
				variantValue = Godot.Variant.From(d);
			}


			CallDeferred("emit_signal", SignalName.ValueChanged, item.StartNodeId.ToString(), variantValue);
		}
		catch (Exception ex)
		{
			GD.Print(ex.ToString());
		}
	}

	public bool Connect(Guid guid, DataType dataType, string nodeName, string tagName)
	{
		if (Protocol == Protocols.opc_ua)
		{
			if(tagName == "-")
			{
				return true;

			}
			if (string.IsNullOrWhiteSpace(tagName))
			{
				GD.PrintErr($"Error connecting tag NULL in node {nodeName}: Empty tag name. If unused type '-' in the field.");
				return false;
			}

			if (tagName.Contains("ns=") && tagName.Contains(';') && tagName.Split(';')[1].StartsWith(" s="))
			{
				GD.PrintErr($"Error connecting tag {tagName} in node {nodeName}: space after namespaceIndex. Format should be: ns=<namespaceIndex>;<identifiertype>=<identifier>");
				return false;
			}

			try
			{
				NodeId.Parse(tagName);
			}
			catch (ArgumentException ex)
			{
				GD.PrintErr($"Error connecting tag {tagName} in node {nodeName}: {ex.Message}");
				return false;
			}

			var nodesToRead = new ReadValueIdCollection
			{
				new ReadValueId
				{
					NodeId = tagName,
					AttributeId = Attributes.UserAccessLevel
				}
			};

			session.Read(null, 0, TimestampsToReturn.Neither, nodesToRead, out DataValueCollection results, out _);

			if (StatusCode.IsBad(results[0].StatusCode))
			{
				GD.PrintErr($"Error connecting tag {tagName} in node {nodeName}: {results[0].StatusCode}");
				return false;
			}

			MonitoredItem item = new()
			{
				StartNodeId = tagName,
				AttributeId = Attributes.Value,
				QueueSize = 0,
				MonitoringMode = MonitoringMode.Reporting,
				SamplingInterval = 100
			};

			item.Notification += this.MonitoredItemHandler;

			subscription.AddItem(item);
			subscription.ApplyChanges();

			opc_tags.Add(guid, tagName);
		}
		else
		{
			if (dataType == DataType.Bool)
			{
				Tag<BoolPlcMapper, bool> tag = new()
				{
					Name = tagName,
					Gateway = Gateway,
					Path = Path,
					PlcType = PlcType,
					Protocol = (Protocol?)Protocol-1,
					Timeout = TimeSpan.FromSeconds(5)
				};

				try
				{
					tag.Initialize();
					bool_tags.Add(guid, tag);
				}
				catch(Exception e)
				{
					GD.PrintErr($"Error connecting tag {tagName} in node {nodeName}: {e.Message}");
					return false;
				}

			}
			else if (dataType == DataType.Int)
			{
				Tag<DintPlcMapper, int> tag = new()
				{
					Name = tagName,
					Gateway = Gateway,
					Path = Path,
					PlcType = PlcType,
					Protocol = (Protocol?)Protocol-1,
					Timeout = TimeSpan.FromSeconds(5)
				};

				try
				{
					tag.Initialize();
					int_tags.Add(guid, tag);
				}
				catch (Exception e)
				{
					GD.PrintErr($"Error connecting tag {tagName} in node {nodeName}: {e.Message}");
					return false;
				}
			}
			else if (dataType == DataType.Float)
			{
				Tag<RealPlcMapper, float> tag = new()
				{
					Name = tagName,
					Gateway = Gateway,
					Path = Path,
					PlcType = PlcType,
					Protocol = (Protocol?)Protocol-1,
					Timeout = TimeSpan.FromSeconds(5)
				};

				try
				{
					tag.Initialize();
					float_tags.Add(guid, tag);
				}
				catch (Exception e)
				{
					GD.PrintErr($"Error connecting tag {tagName} in node {nodeName}: {e.Message}");
					return false;
				}
			}
		}

		return true;
	}

	private T HandleOpcUaRead<T>(Guid guid)
	{
		var value = session.ReadValueAsync(opc_tags[guid]).Result.Value;

		if (value is T typedValue)
		{
			return typedValue;
		}
		else
		{
			string errorMessage = $"Expected {typeof(T)} but received {value.GetType()} for nodeid: {opc_tags[guid]}";
			GD.PrintErr(errorMessage);
			throw new InvalidCastException(errorMessage);
		}
	}

	public async Task<bool> ReadBool(Guid guid)
	{
		if (Protocol == Protocols.opc_ua)
			return HandleOpcUaRead<bool>(guid);
		else
			return Convert.ToBoolean(await bool_tags[guid].ReadAsync());
	}

	public async Task<int> ReadInt(Guid guid)
	{
		if (Protocol == Protocols.opc_ua)
			return HandleOpcUaRead<int>(guid);
		else
			return Convert.ToInt32(await bool_tags[guid].ReadAsync());
	}

	public async Task<float> ReadFloat(Guid guid)
	{
		if (Protocol == Protocols.opc_ua)
			return HandleOpcUaRead<float>(guid);
		else
			return (float)(await float_tags[guid].ReadAsync());
	}
	public async Task Write(Guid guid, bool value)
	{
		if (Protocol == Protocols.opc_ua)
		{
			RequestHeader requestHeader = new();

			WriteValueCollection writeValues = new();

			WriteValue writeValue = new()
			{
				NodeId = new NodeId(opc_tags[guid]),
				AttributeId = Attributes.Value,
				Value = new DataValue
				{
					Value = Convert.ToBoolean(value)
				}
			};

			writeValues.Add(writeValue);

			await session.WriteAsync(requestHeader, writeValues, new System.Threading.CancellationToken());
		}
		else
		{
			bool_tags[guid].Value = value;

			try
			{
				bool_tags[guid].Value = value;
				await bool_tags[guid].WriteAsync();
			}
			catch(Exception e)
			{
				CallDeferred(nameof(PrintError), e.Message);
			}

		}
	}

	public async Task Write(Guid guid, int value)
	{
		if (Protocol == Protocols.opc_ua)
		{
			RequestHeader requestHeader = new();

			WriteValueCollection writeValues = new();

			WriteValue writeValue = new()
			{
				NodeId = new NodeId(opc_tags[guid]),
				AttributeId = Attributes.Value,
				Value = new DataValue
				{
					Value = Convert.ToInt16(value)
				}
			};

			writeValues.Add(writeValue);

			await session.WriteAsync(requestHeader, writeValues, new System.Threading.CancellationToken());
		}
		else
		{
			int_tags[guid].Value = value;
			await int_tags[guid].WriteAsync();
		}
	}

	public async Task Write<T>(Guid guid, T value)
	{
		if (Protocol == Protocols.opc_ua)
		{
			RequestHeader requestHeader = new();

			WriteValueCollection writeValues = new();

			WriteValue writeValue = new()
			{
				NodeId = new NodeId(opc_tags[guid]),
				AttributeId = Attributes.Value,
				Value = new DataValue
				{
					Value = value
				}
			};

			writeValues.Add(writeValue);

			await session.WriteAsync(requestHeader, writeValues, new System.Threading.CancellationToken());
		}
	}

	public async Task Write(Guid guid, float value)
	{
		if (Protocol == Protocols.opc_ua)
		{
			RequestHeader requestHeader = new();

			WriteValueCollection writeValues = new();

			WriteValue writeValue = new()
			{
				NodeId = new NodeId(opc_tags[guid]),
				AttributeId = Attributes.Value,
				Value = new DataValue
				{
					Value = value
				}
			};

			writeValues.Add(writeValue);

			await session.WriteAsync(requestHeader, writeValues, new System.Threading.CancellationToken());
		}
		else
		{
			try
			{
				float_tags[guid].Value = value;
				await float_tags[guid].WriteAsync();
			}
			catch (Exception e)
			{
				CallDeferred(nameof(PrintError), e.Message);
			}
		}
	}

	private static void PrintError(string error)
	{
		GD.PrintErr(error);
	}

	public override void _Ready()
	{
		if (GetNodeOrNull("/root/SimulationEvents") != null)
		{
			var simulationEvents = GetNode("/root/SimulationEvents");
			simulationEvents.Connect("simulation_started", new Callable(this, nameof(OnSimulationStarted)));
			simulationEvents.Connect("simulation_set_paused", new Callable(this, nameof(OnSimulationSetPaused)));
			simulationEvents.Connect("simulation_ended", new Callable(this, nameof(OnSimulationEnded)));
		}
	}

	public override void _EnterTree()
	{
		EditorInterface.Singleton.GetSelection().Connect(EditorSelection.SignalName.SelectionChanged, new Callable(this, MethodName.OnSelectionChanged));
	}

	public override void _ExitTree()
	{
		var selection = EditorInterface.Singleton.GetSelection();
		var signalName = EditorSelection.SignalName.SelectionChanged;
		var callable = new Callable(this, MethodName.OnSelectionChanged);
		if (!selection.IsConnected(signalName, callable)) return;
		selection.Disconnect(signalName, callable);
	}

	public void OnSelectionChanged()
	{
		selectedNodes = EditorInterface.Singleton.GetSelection().GetSelectedNodes();
		SelectNodes();
	}

	void SelectNodes()
	{
		if (selectedNodes.Count > 0)
		{
			foreach (var node in selectedNodes)
			{
				if (node.HasMethod("Select"))
				{
					node.Call("Select");
				}
			}
		}
	}

	public override void _Process(double delta)
	{
		SelectNodes();
	}

	void OnSimulationStarted()
	{
		if (Protocol == Protocols.opc_ua && !string.IsNullOrEmpty(EndPoint))
		{
			if(session != null && session.Endpoint.EndpointUrl.TrimEnd('/') != EndPoint.TrimEnd('/'))
			{
				foreach (var item in subscription.MonitoredItems)
				{
					item.Notification -= MonitoredItemHandler;
				}
				subscription.RemoveItems(subscription.MonitoredItems);
				session.Close();
				session = null;
			}
			if (session == null)
			{
				OpcConnect();
			}
		}

		Start = true;
	}

	void OnSimulationSetPaused(bool _paused)
	{
		simulationPaused = _paused;

		if (simulationPaused)
		{
			ProcessMode = ProcessModeEnum.Disabled;
		}
		else
		{
			ProcessMode = ProcessModeEnum.Inherit;
		}

		EmitSignal(SignalName.SimulationSetPaused, simulationPaused);
	}

	void OnSimulationEnded()
	{
		Start = false;
	}
}
