# OpenIndustryProject

Free and Open-source warehouse/manufacturing development framework and simulator made with [JoltPhysics](https://github.com/jrouwe/JoltPhysics), [open62541](https://github.com/open62541/open62541), [libplctag](https://github.com/libplctag/libplctag), and with/for [Godot](https://github.com/godotengine),  

The goal is to provide an open framework to create software and simulations using industrial equipment/devices and for people to be able to test their ideas or simply educate themselves while using standard industrial platforms.

Scroll down to the **Getting Started** section for information on how to work with this project. 

Join our discord group: [Open Industry Project](https://discord.gg/ACRPr6sBpH)

Supported Communication Protocols:

- OPC UA via open62541
- Ethernet/IP via libplctag
- Modbus TCP via libplctag

## Demo

https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/e78c3b0a-bb8e-411a-aa17-b2b6534868a4


## Out of the Box Features 

Customizable Equipment

https://github.com/user-attachments/assets/0d3ae08d-e80a-4495-8059-7056c406584f

https://github.com/user-attachments/assets/00a2b3e6-03c3-45a1-b917-d71f6fdef13a

Dynamic Devices

https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/1e74dc9c-0613-43cf-a864-8fc78a2785ca

## Getting Started

It is recommended to download the latest package here: https://github.com/Open-Industry-Project/Open-Industry-Project/releases

It comes with a fork that contains functions and features that are not avaliable in regular Godot.

The contents of this repo are parts of a regular Godot project. You can open this project via the project manager, just like any other Godot project.

Use the Project Manager to create a new project.

![image](https://github.com/user-attachments/assets/3de4a320-89bc-4088-86b7-a814da0e726d)

All objects used in a simulation scene will be in the Parts tab. 

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/fd0fd71c-e3fa-43cb-99b5-4b9d65d04727)

A simulation can be created by adding a new scene, and selecting "New Simulation".

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/d28ec7a4-a3e2-4659-8b9a-3946c8baa528)

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/2745376e-185a-4963-8c32-a416ca4174bc)

This creates a new scene with the top node labelled "Simulation":

![image](https://github.com/user-attachments/assets/da960e60-cbb3-4a32-8630-a566ba8bb053)

Parts can be dragged into the viewport to instantiate it. Once they're in the scene they can be modified. 

https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/fc3dca44-ceab-4ecf-8c7d-cd5754fce558

Most parts have properties that can be setup to communicate to a PLC or OPC Server (see [communications below](#communications)). In this example Ignition was used as an OPC server to write to the conveyor tag.

https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/c14ec7ba-a0ed-4163-850a-4f75f8ec5579

## Communications

Configure the communication to PLCs or an OPC UA server via the "Comms" panel on the bottom of the editor:

![image](https://github.com/user-attachments/assets/1582640d-fd9c-48e2-9c72-4f5c03e1cb3a)

The simulator will not communicate with any device until the "Enable Comms" checkbox is checked. Each tag group is associated with one PLC or or one OPC UA client. Multiple PLCs or OPC UA clients are supported. It is possible to set up multiple tag groups to connect to a single PLC, however, this is not recommended since the internal libraries (libplctag or open62541) are likely expecting a single endpoint device to be one connection.

The "Polling Rate" indicates how often OIPComms will read all the tags which are a part of that tag group. Note that the simulation does not read directly from the devices, it reads from a thread-safe data buffer that holds the value retained from the last poll. Writing values from the simualtion occurs as soon as possible, and is also thread-safe.

In the event that a write operation is queued by the simulation and a poll is half-way through completing (for example 100 out of 200 tags in the group have been read), the write operation will not complete until the poll completes.

The "Gateway" is the IP address of the target controller, and the path is the typically the rack/slot location of the PLC. The "CPU" dropdown contains the following options:

![image](https://github.com/user-attachments/assets/c376d234-548f-41de-bada-fe27f6d00bd5)

Selecting the Protocol dropdown provides three options:
- `ab_eip` - Ethernet/IP communication via the libplctag library
- `modbus_tcp` - Modbus TCP communication via the libplctag library
- `opc_ua` - OPC UA communication via the open62541 library

When changing the Protocol  to `opc_ua`, the options change to reflect the connection parameters for an OPC UA endpoint:

![image](https://github.com/user-attachments/assets/381969f0-d8e4-4033-93e4-88dc77920f69)

The "Endpoint" is the OPC UA protocol address which includes the IP address and port of the server. The "Namespace" is typically 1 unless otherwise specified by the OPC UA server.

The communication API ([OIPComms](https://github.com/bikemurt/OIP_gdext/)) is contained within a separate GDextension plugin. Instructions to build and update it are located in its own repository.

## Importing Models

Although this project has a few models, you maybe interested in adding more. 

This is a good resource for free industrial parts CAD models: [3dfindit](https://www.3dfindit.com/en/)

It is recommened to export the files in their native format (usually STEP), modify them if needed for usage in Godot in any CAD software and then export as FBX for additional work in Blender, or to be imported straight into Godot. 

Alternatively most manufacturers provide the CAD files directly on their own website. 

## Help Wanted

- More equipment and devices
- Better exception handling
- Review code
- Documentation
- Training videos?


