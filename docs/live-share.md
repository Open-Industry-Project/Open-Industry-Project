# Live share and Watch only

Live share lets one editor in a room stream its running simulation to everyone else in that room. Viewers see the
run as it happens, with nothing installed and nothing to control. Watch only lets a controller connect to a PLC that
runs real equipment without ever writing to it. Together they give a live view of a real line: the desktop app
watches the PLCs, and a view link shows the result to anyone with a browser.

## What a viewer sees, and what it runs

A viewer draws the sharer's frames and runs nothing of its own. It has no worker, no PLC program and no part code.
The store stays stopped, so Use, cargo promotion, the PLC panels and every other run-owned control are idle, and the
document is never written. Only the view is put in its running state, because that is what draws cargo and run poses
([controller/liveView.ts](../src/editor/controller/liveView.ts)).

So a viewer sees exactly what the sharer sees, whatever drives the sharer's run: the program here, a real PLC, or a
mix of both. That includes the boxes, and the sharer's PLC variables: a viewer's watch table is the sharer's
(`plcWatch` answers from the stream while following), so a note's counter, the Watch panel and the Inspector's tag
values read what the sharer's do. The room already holds the program's text, so its values reveal nothing more.

"Live" means only this stream. The UI never says "room": a shared project is named everywhere, by its own name for
its owner and by the name its room carries for everyone else (`PROJECT_NAME_META` in collab/schema.ts; a room from
before names reads as "Shared project"). Share keeps its label once shared, and who is here shows as avatars beside it
(components/PresenceStack.tsx): a circle per person in their presence colour, the live one ringed, and a click lists
everyone with what they are doing and holds the name field, which is how a view-link visitor names themselves.

A view link follows a shared run on its own: watching is what it is for. Between runs it says "Gannet is live ·
waiting for a run", so a visitor who opens the link early knows something is coming. An editor is offered it instead ("Gannet is
live · Watch" beside Play) and follows only after accepting, because a run taking over the view of someone who is
editing would be an interruption. A follower's chip names whose run it is, and an editor's has a × to stop watching.
While following, Play is drawn outlined rather than filled, and reads "Run my own copy": it runs a private copy as
before, and Stop goes back to following. On a phone each chip shrinks to its dot and a word, and the view-only badge
steps aside while one shows. Editors can keep editing while they follow, and an edit reaches the sharer's run the way any live edit
does.

## Going live

The Share popover keeps two questions apart. Its links decide who gets in: Can edit (build and run) and Can view
(watch). Its Live switch, under them, decides whether this client's runs stream to whoever is in. The switch only
switches; copying a link is the links' job.

From a solo tab, the switch and both links first make a room, seeded from what is on screen, and the tab enters it in
place: no reload, and the popover stays open on the links ([roomEntry.ts](../src/editor/roomEntry.ts), main.tsx
`registerRoomEntry`). The solo saves stand down once the store is in collab mode, so nothing done in the room is written
over the project. Until the room's document has synced and its bridge is up, the editor is held read-only, because an
edit made in between would land in a store the room's document then replaces. Live turns on only after that. A surface
that cannot enter in place reloads into the room instead, and a mark in sessionStorage carries the intent across the
reload ([live/liveChannel.ts](../src/editor/live/liveChannel.ts) `markGoLive`).

### Sharing a project

Sharing one of the user's projects keeps it their project, as a shared document is elsewhere
([project/sharedProject.ts](../src/editor/project/sharedProject.ts)). There is no second copy to keep track of:

- The project keeps its name and its place in the Projects list, where a small people icon marks it shared. The
  project menu shows its name, as always: that it is shared shows where sharing is controlled (Invite, and who is in
  beside it). Rename Project works on it as on any project of the user's.
- While it is shared its room is where everyone edits it, and this browser, which owns it, writes the room's document
  back into the project a moment after each change, its own edits and collaborators' alike. The project never falls
  behind the room. A room carries the scene, the program and the parts, not the project's tests, so the write-back keeps
  whatever the room does not carry from the project as last saved (sharedProject.ts `projectNow`). The desktop folder
  sync writes the same merge, so a project's `tests/` files are not deleted.
- The project's tests stay the owner's: in its room the owner's tab loads them from the project, runs them, and keeps a
  test it adds or deletes, which the write-back saves (`startWriteBack`, store `saveProjectTest`). A collaborator's
  browser has no project to keep tests in, so it has none.
- Opening another project, a new one, or an imported file leaves the shared project, in the browser and on the desktop
  alike. Its room stays open for the others.
- Opening the project again, from the Projects list or by opening the app, opens it in its room (main.tsx
  `roomToOpen`). If the server has lost the room, the owner seeds it again from the project.
- Live is only the stream. Switching it off changes nothing else, and the popover says the project stays shared.
- **Stop sharing** (the popover, or File > Stop Sharing This Project) makes the project the user's alone again: it is
  already up to date, the room is closed, so the links handed out stop working, and the tab opens the project solo.
  Anyone still in the room is sent back to the app and told it was closed; a link opened later is refused, and a copy
  of the room a browser had cached is dropped rather than shown.
- On the desktop, a shared project's folder keeps following it, from the room
  ([projectFolderSync.ts](../src/editor/project/projectFolderSync.ts)): git, backups and agents see every change. It
  is one way while shared. A change made to the folder meanwhile is not loaded, because a load replaces the project
  under the room rather than editing it: the sync waits, with a banner saying why, moving nothing, and when the project
  stops being shared it takes the change, or asks about it, as it always does.

Which projects are shared, and with which room, is this browser's record (`oip-web/shared-projects`). Closing a room
cannot rest on the edit secret, since every editor holds it, so the browser that shares a project mints an owner token,
registers it with the room once connected, and closes the room with it ([server/roomOwners.mjs](../server/roomOwners.mjs):
the server keeps only its hash, deletes a closed room and refuses it from then on). Someone who joins with the edit link
edits the owner's project but cannot close it; to have a project of their own they make a copy (File > Make a Copy).
The demo, shared, stays the current demo until someone edits it (collab/demoRoom.ts), so it is not written back into a
project, but it is owned like any share: whoever shared it can stop sharing it, which closes it and takes them back to the
demo on their own, and nobody else can claim it. Until then, opening the demo again in that browser opens its room, as
opening a shared project does (main.tsx `roomToOpen`), so the sharer can always get back to it to stop sharing.

A room nobody has claimed (one from before owner tokens) is claimed by the first writer that asks. The app only asks for a project of the user's own, but a writer could ask by hand. Where the server cannot close
a room (one claimed by someone else, or an older server), Stop sharing says the links would still open it and asks
before going on.

Both kinds of link see a live run. A view link is drawn into it; an editor is offered it and can keep editing. An
editor's changes are document edits, and a running sim takes live edits, so they show in the stream: a class can
build a line together and watch it react. To keep an audience to watching, give it only the view link.

While live, a badge sits beside Play. It is a status: clicking it opens Share, where the switch is, so Live is turned on
and off in one place and a stray click never ends a stream. Before a run it reads "Live" with a hollow dot; during one
it pulses and counts the audience, "Live · 3 watching", from presence (`watching` in collab/session.ts). A live run is not counted among the people running their own copy.
Presence carries who is live (`live` in collab/session.ts), so one person is live in a room at a time: the others'
Share popovers show the switch disabled, saying who is. Stopping the run, or leaving the room, ends it for every viewer.
Switching Live off or leaving tells them: "Gannet stopped streaming", for a few seconds, where the chip was.

## The stream

[core/live/liveFrameWire.ts](../src/core/live/liveFrameWire.ts) encodes the sim worker's frame (`BoxFrame`) as compact
binary. A worker frame is about 330 KB as JSON on the demo, but only 15 to 20 of its 1,100 bodies move in a frame. So
each message carries only what changed since the previous one:

- bodies added, changed or gone, each with its size, colour, kind and owning part sent once
- the poses that moved, with position rounded to 0.1 mm and rotation as the smallest three quaternion components in
  16 bits, sent when a body moved more than 0.5 mm
- per-part records (joints, lamps, displays, tags, belt speeds, mobile bases) whose value changed
- dressings as patches, and each cargo shape once

Measured on the demo with the line running: 0.8 KB a frame on average, 16 KB/s per viewer at 20 Hz before the
WebSocket's own compression, and a worst position error of 0.44 mm. A snapshot for a late joiner is about 150 KB.

The sharer sends 20 frames a second and a snapshot every 5 seconds
([collab/liveShare.ts](../src/collab/liveShare.ts)). A viewer plays about 0.12 s behind the newest frame and blends the
two either side of its play time ([core/live/livePlayback.ts](../src/core/live/livePlayback.ts)). Its play clock runs
at the sharer's rate, so a fast-forwarded run plays fast and a paused one holds.

## The relay

Messages travel as Hocuspocus stateless strings, `live1|<kind>|<stream>|<base64>`, and the collab server relays them
([server/liveRelay.mjs](../server/liveRelay.mjs)). They never enter the room's document.

| Kind | Sent by | The server |
|---|---|---|
| `s` snapshot | the sharer, at start and every 5 s | keeps it, does not relay it |
| `d` delta | the sharer, 20 a second | relays it to every other connection, and keeps it after the snapshot |
| `e` end | the sharer, at Stop | relays it and drops the stream |
| `r` resync | a viewer that missed a delta | answers that viewer alone with the snapshot and the deltas after it |

A connection that joins during a run is sent the snapshot and the deltas after it. Only a connection holding the
edit secret may send `s`, `d` or `e`; a view-only one may only ask to be caught up, and the server answers only it.
BroadcastStateless stays refused, because it would let any viewer relay text to everyone in the room. A sharer that
disconnects ends its stream for everyone.

Deploy the collab server before a web or desktop build that can share. A server from before live share closes any
connection that sends a stateless message, so a sharer on an old server is disconnected the moment it starts.

## Watch only

A controller set to Watch only (Controller Properties, or the named controller's settings) reads every tag from its
PLC, including the ones parts write, and writes nothing to it. It is a project setting (`ScenePlc.watch`), saved with
the scene and undone like any edit.

Every point of the link becomes "read from the PLC" ([links/externalPlc.ts](../src/editor/links/externalPlc.ts)
`watchedPoints`). A sensor's tag is then driven by the PLC, so a part that shows what drives its tag shows the real
value. The first-party photo eye, push button, light curtain and safety gate do this: while `ctx.tagDriven(tag)` holds
they show `ctx.readTag(tag)` and not what they sense. A custom part can follow the same pattern.

Watch only does not work over Modbus. In serve mode the PLC reads its inputs from the simulator, and in poll mode the
simulator reads only input registers. Over Modbus a watched controller connects nothing, and the PLC panel says why.

Without Watch only, a link writes the simulator's sensor values into the PLC. Never connect one to a PLC that runs real
equipment.

## Self-hosting

A room lives on one collab server. The server a tab uses is, in order:

1. the one its room link names (`&server=wss://...`)
2. this computer's choice (Settings > Live editing > Collaboration server)
3. the build's default

The links Share copies name the server when it is not the build's. So a team that runs its own collab server sets it
once in the desktop app, and its view links open on the public site but connect to its server. Their data never
passes through ours. A link that names another server shows a notice saying where the room is kept, because anyone
can write such a link. Desktop links (`openindustry://open?room=...&server=...`) carry the server too
([apps/desktop/deepLink.cjs](../apps/desktop/deepLink.cjs)), and the shell accepts only a ws:// or wss:// address.

## Gates

- `e2e/verify-collab-auth.mjs`: against the real server, a writer's delta reaches a viewer, a viewer's resync and a
  viewer joining mid-run are caught up, and a viewer that tries to stream is cut off.
- `e2e/verify-shared-project.mjs`: Live shares a solo project in place, tagged Shared under its name; an edit in the
  room, the owner's or a collaborator's, reaches the project by itself; Live off leaves it shared; opening the app again
  opens it in its room; Stop sharing makes it solo with everything kept and closes the room, so its links stop working.
- `e2e/verify-live-share.mjs`: an editor shares the demo's run against a real collab server. A view-link tab follows
  it without running anything, a tab joining mid-run starts from the snapshot, the viewer's own Play and Stop take
  over and give back, and Stop ends the run for everyone.
- Unit tests: `core/live/*.test.ts`, `collab/liveShare.test.ts`, `server/liveRelay.test.mjs`, and Watch only in
  `links/externalPlc.test.ts` and `store/storePlcs.test.ts`.
