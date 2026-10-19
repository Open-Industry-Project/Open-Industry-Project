"""The PLC side of scripts/s7-loop.mjs: snap7's S7 server, with the loop's program running over its memory.

snap7 (https://snap7.sourceforge.net, its C library through python-snap7 2.x) answers S7 PUT/GET as a CPU's
communication stack does: COTP connect, PDU negotiation, read-var and write-var jobs on the I (PE), Q (PA) and
M (MK) areas. It runs no program, so this script is the program: every SCAN_MS it reads the inputs out of the
server's own buffers, runs the conveyor case's logic (scripts/lib/conveyor-loop.mjs, transcribed by hand
below), and writes the outputs back. The bytes the simulator sent are decoded here with Python's struct, big-
endian, so nothing of the simulator's encoding is shared with this side.

It also plants a "real input card" in the eye's byte: every other bit of it is set and must still be set at the
end, which is what a client that writes a BIT, not its byte, leaves alone.

Protocol with the loop, one JSON object per line on stdout:
  {"ready": true}                   listening; the loop may connect
  {"end": ..., "scans": n, ...}     after stdin closes (the loop is done): what the server saw
"""

import ctypes
import json
import struct
import sys
import threading
import time

import snap7
from snap7.type import SrvArea

ARGS = json.loads(sys.argv[1])
PORT = ARGS["port"]
SCAN_MS = ARGS["scanMs"]
EYE, RUN = ARGS["eye"], ARGS["run"]  # [byte, bit] in I and Q
# the two REALs: {"area": "I" | "Q" | "DB", "db": n, "byte": n}; a DB is registered as the data block it names
RANGE, SPEED = ARGS["range"], ARGS["speed"]
FAST, CREEP, CREEP_WITHIN = ARGS["fast"], ARGS["creep"], ARGS["creepWithin"]
SIZE = 256

# snap7's event codes (snap7.h evcDataRead / evcDataWrite)
EVC_DATA_READ = 0x00020000
EVC_DATA_WRITE = 0x00040000

if not snap7.__version__.startswith("2."):
    print(json.dumps({"error": f"python-snap7 {snap7.__version__} is the pure-Python rewrite, whose server writes one item per job and a bit as its whole byte; the loop needs 2.x, which wraps the C library"}), flush=True)
    sys.exit(2)

inputs = (ctypes.c_ubyte * SIZE)()
outputs = (ctypes.c_ubyte * SIZE)()
memory = (ctypes.c_ubyte * SIZE)()
NEIGHBOURS = 0xFF & ~(1 << EYE[1])
inputs[EYE[0]] = NEIGHBOURS  # the input card's other bits, which the simulator must not touch

server = snap7.server.Server(log=False)
server.register_area(SrvArea.PE, 0, inputs)
server.register_area(SrvArea.PA, 0, outputs)
server.register_area(SrvArea.MK, 0, memory)
blocks = {}
for at in (RANGE, SPEED):
    if at["area"] == "DB" and at["db"] not in blocks:
        blocks[at["db"]] = (ctypes.c_ubyte * SIZE)()
        server.register_area(SrvArea.DB, at["db"], blocks[at["db"]])


def area_of(at):
    """The server area and buffer a REAL lives in."""
    if at["area"] == "DB":
        return SrvArea.DB, at["db"], blocks[at["db"]]
    return (SrvArea.PE, 0, inputs) if at["area"] == "I" else (SrvArea.PA, 0, outputs)
server.start_to("127.0.0.1", PORT)

done = threading.Event()
threading.Thread(target=lambda: (sys.stdin.read(), done.set()), daemon=True).start()
print(json.dumps({"ready": True}), flush=True)

creeping = False
scans = reads = writes = 0
while not done.is_set():
    started = time.perf_counter()
    server.lock_area(SrvArea.PE, 0)
    box_at_eye = bool(inputs[EYE[0]] >> EYE[1] & 1)
    server.unlock_area(SrvArea.PE, 0)
    kind, index, buf = area_of(RANGE)
    server.lock_area(kind, index)
    box_range = struct.unpack(">f", bytes(buf[RANGE["byte"] : RANGE["byte"] + 4]))[0]
    server.unlock_area(kind, index)

    # the program (conveyor-loop.mjs conveyorCase), line for line
    conveyor_run = not box_at_eye
    if 0.0 < box_range < CREEP_WITHIN:
        creeping = True
    if not conveyor_run:
        creeping = False
    belt_speed = CREEP if creeping else FAST

    server.lock_area(SrvArea.PA, 0)
    if conveyor_run:
        outputs[RUN[0]] |= 1 << RUN[1]
    else:
        outputs[RUN[0]] &= ~(1 << RUN[1]) & 0xFF
    server.unlock_area(SrvArea.PA, 0)
    kind, index, buf = area_of(SPEED)
    server.lock_area(kind, index)
    buf[SPEED["byte"] : SPEED["byte"] + 4] = list(struct.pack(">f", belt_speed))
    server.unlock_area(kind, index)
    scans += 1

    while True:
        event = server.pick_event()
        if not event:
            break
        if event.EvtCode == EVC_DATA_READ:
            reads += 1
        elif event.EvtCode == EVC_DATA_WRITE:
            writes += 1
    time.sleep(max(0.0, SCAN_MS / 1000 - (time.perf_counter() - started)))

status = server.get_status()
server.stop()
server.destroy()
print(
    json.dumps(
        {
            "end": True,
            "scans": scans,
            "reads": reads,
            "writes": writes,
            "neighbours": inputs[EYE[0]] & NEIGHBOURS,
            "expectedNeighbours": NEIGHBOURS,
            "server": status[0],
        }
    ),
    flush=True,
)
