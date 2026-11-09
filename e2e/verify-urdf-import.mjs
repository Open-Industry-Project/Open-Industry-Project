// A URDF robot imports through Import part > A robot (URDF)... as a new part: a rig link per URDF link, a joint per
// moving joint, and one GLB with a node per link (editor/urdfImport.ts, core/urdf.ts, core/urdfRig.ts).
//
//   A) Import part offers "A robot (URDF)…" in the browser
//   B) picking the robot's folder makes a part named after the robot, its links and joints as the file has them,
//      posable, with the GLB holding one node per drawn link
//   C) the meshes resolve (package:// and relative), read in their units and up axis (a binary STL in millimetres,
//      a COLLADA file in centimetres, Z up), and the rendered links stand where URDF puts them, Z up turned to Y up
//   D) the part's bounds are the rest pose's
//   E) a lone .urdf (no folder) imports its primitives and says which meshes it could not find
//   F) a xacro file is expanded first: one whose include is not there says which file is missing
//   H) a xacro description in two ROS packages, whose model argument names none by default, asks which model (the
//      models its YAML folders hold), then asks about the on/off argument that adds a link (not the one that adds
//      only a simulator tag), and imports what was picked: its macro, its include through $(find), its YAML
//   G) mimic and collision: a second finger follows the first (a joint `mimic`), each <collision> is a hidden collider
//      link, and running the robot in a scene, a box dropped on its base comes to rest on the base's collider
//
// The robot is written here, first-party: a 0.2 m cube base (STL, a box collider), a 0.5 m arm (COLLADA, an STL
// collision mesh) on a yawing shoulder, a finger (a URDF box) on a sliding joint, and a second finger mimicking it.
//
//   node e2e/verify-urdf-import.mjs
/* global process, console, window, localStorage, Buffer */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

// ---- the robot ------------------------------------------------------------------------------------------------

/** A box's 12 triangles, outward, from `lo` to `hi`. */
function boxTriangles(lo, hi) {
  const c = (i) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ]
  return quads.flatMap(([a, b, d, e]) => [
    [c(a), c(b), c(d)],
    [c(a), c(d), c(e)],
  ])
}

/** A binary STL of `tris`. */
function stl(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((t, i) => {
    const o = 84 + i * 50
    const u = t[1].map((v, k) => v - t[0][k])
    const w = t[2].map((v, k) => v - t[0][k])
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    const len = Math.hypot(...n) || 1
    n.forEach((v, k) => buf.writeFloatLE(v / len, o + k * 4))
    t.forEach((p, j) => p.forEach((v, k) => buf.writeFloatLE(v, o + 12 + j * 12 + k * 4)))
  })
  return buf
}

/** A COLLADA file of `tris`, in centimetres, Z up, in one red material. */
function dae(tris) {
  const pts = tris.flat()
  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><unit name="centimeter" meter="0.01"/><up_axis>Z_UP</up_axis></asset>
  <library_effects><effect id="red-fx"><profile_COMMON><technique sid="common"><lambert>
    <diffuse><color>0.8 0.1 0.1 1</color></diffuse>
  </lambert></technique></profile_COMMON></effect></library_effects>
  <library_materials><material id="red" name="red"><instance_effect url="#red-fx"/></material></library_materials>
  <library_geometries><geometry id="arm-mesh"><mesh>
    <source id="arm-pos"><float_array id="arm-pos-a" count="${pts.length * 3}">${pts.flat().join(' ')}</float_array>
      <technique_common><accessor source="#arm-pos-a" count="${pts.length}" stride="3">
        <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
      </accessor></technique_common></source>
    <vertices id="arm-vtx"><input semantic="POSITION" source="#arm-pos"/></vertices>
    <triangles material="red" count="${tris.length}"><input semantic="VERTEX" source="#arm-vtx" offset="0"/>
      <p>${pts.map((_, i) => i).join(' ')}</p></triangles>
  </mesh></geometry></library_geometries>
  <library_visual_scenes><visual_scene id="scene"><node id="arm" name="arm">
    <instance_geometry url="#arm-mesh"><bind_material><technique_common>
      <instance_material symbol="red" target="#red"/>
    </technique_common></bind_material></instance_geometry>
  </node></visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>`
}

const URDF = `<?xml version="1.0"?>
<robot name="demo_arm">
  <material name="grey"><color rgba="0.5 0.5 0.5 1"/></material>
  <link name="base_link">
    <visual>
      <geometry><mesh filename="package://demo_arm_description/meshes/base.stl" scale="0.001 0.001 0.001"/></geometry>
      <material name="grey"/>
    </visual>
    <collision><origin xyz="0 0 0.1"/><geometry><box size="0.2 0.2 0.2"/></geometry></collision>
  </link>
  <link name="arm">
    <visual><geometry><mesh filename="../meshes/visual/arm.dae"/></geometry></visual>
    <collision><geometry><mesh filename="package://demo_arm_description/meshes/collision/arm.stl"/></geometry></collision>
  </link>
  <link name="finger2"/>
  <link name="finger">
    <visual>
      <origin xyz="0.02 0 0" rpy="0 0 0"/>
      <geometry><box size="0.04 0.02 0.02"/></geometry>
      <material name="tip"><color rgba="0 0.6 0 1"/></material>
    </visual>
  </link>
  <link name="tool0"/>
  <joint name="shoulder" type="revolute">
    <parent link="base_link"/><child link="arm"/>
    <origin xyz="0 0 0.2" rpy="0 0 0"/>
    <axis xyz="0 0 1"/>
    <limit lower="-2" upper="2" effort="10" velocity="1"/>
  </joint>
  <joint name="slide" type="prismatic">
    <parent link="arm"/><child link="finger"/>
    <origin xyz="0.5 0 0" rpy="0 0 0"/>
    <axis xyz="1 0 0"/>
    <limit lower="0" upper="0.05" effort="10" velocity="0.1"/>
  </joint>
  <joint name="slide2" type="prismatic">
    <parent link="arm"/><child link="finger2"/>
    <origin xyz="0.5 0 0" rpy="0 0 0"/>
    <axis xyz="0 -1 0"/>
    <limit lower="0" upper="0.05" effort="10" velocity="0.1"/>
    <mimic joint="slide"/>
  </joint>
  <joint name="flange" type="fixed">
    <parent link="finger"/><child link="tool0"/>
    <origin xyz="0.04 0 0" rpy="0 0 0"/>
  </joint>
</robot>`

const dir = mkdtempSync(join(tmpdir(), 'oip-urdf-'))
const pkg = join(dir, 'demo_arm_description')
mkdirSync(join(pkg, 'urdf'), { recursive: true })
mkdirSync(join(pkg, 'meshes', 'visual'), { recursive: true })
mkdirSync(join(pkg, 'meshes', 'collision'), { recursive: true })
writeFileSync(join(pkg, 'meshes', 'collision', 'arm.stl'), stl(boxTriangles([0, -0.05, -0.05], [0.5, 0.05, 0.05])))
writeFileSync(join(pkg, 'urdf', 'demo_arm.urdf'), URDF)
// a 200 mm cube standing on the base's origin
writeFileSync(join(pkg, 'meshes', 'base.stl'), stl(boxTriangles([-100, -100, 0], [100, 100, 200])))
// a 50 cm arm along +X, 10 cm square
writeFileSync(join(pkg, 'meshes', 'visual', 'arm.dae'), dae(boxTriangles([0, -5, -5], [50, 5, 5])))
writeFileSync(join(dir, 'macro.urdf'), '<robot name="m" xmlns:xacro="http://www.ros.org/wiki/xacro"><xacro:include filename="arm.xacro"/></robot>')

// H: a xacro robot in two packages. The description picks its dimensions from config/<model>/dims.yaml, and the arm
// macro lives in a second package it finds with $(find). Plain strings, so the ${...} is xacro's, not JavaScript's.
const xacroWs = join(dir, 'xbot_ws')
for (const d of ['xbot_description/urdf', 'xbot_description/config/m1', 'xbot_description/config/m2', 'xbot_macros/urdf']) mkdirSync(join(xacroWs, d), { recursive: true })
writeFileSync(join(xacroWs, 'xbot_description', 'package.xml'), '<package><name>xbot_description</name></package>')
writeFileSync(join(xacroWs, 'xbot_macros', 'package.xml'), '<package><name>xbot_macros</name></package>')
writeFileSync(join(xacroWs, 'xbot_description', 'config', 'm1', 'dims.yaml'), 'upper: 0.4\nfore: 0.3\n')
writeFileSync(join(xacroWs, 'xbot_description', 'config', 'm2', 'dims.yaml'), 'upper: 0.6\nfore: 0.35\n')
writeFileSync(
  join(xacroWs, 'xbot_description', 'urdf', 'xbot.urdf.xacro'),
  '<?xml version="1.0"?>\n<robot xmlns:xacro="http://wiki.ros.org/xacro" name="xbot">\n' +
    '  <xacro:arg name="model" default="none"/>\n' +
    '  <xacro:arg name="tip" default="false"/>\n' +
    '  <xacro:arg name="sim" default="true"/>\n' +
    '  <xacro:include filename="$(find xbot_macros)/urdf/arm.xacro"/>\n' +
    "  <xacro:xbot_arm dims=\"${xacro.load_yaml('$(find xbot_description)/config/$(arg model)/dims.yaml')}\"/>\n" +
    '  <xacro:if value="$(arg tip)"><link name="tip"><visual><geometry><box size="0.05 0.05 0.05"/></geometry></visual></link>' +
    '<joint name="tip_mount" type="fixed"><parent link="tool0"/><child link="tip"/></joint></xacro:if>\n' +
    '  <xacro:if value="$(arg sim)"><gazebo/></xacro:if>\n' +
    '</robot>\n',
)
const J = (name, parent, child, xyz) =>
  `<joint name="${name}" type="revolute"><parent link="${parent}"/><child link="${child}"/><origin xyz="${xyz}"/><axis xyz="0 1 0"/><limit lower="-3" upper="3" effort="1" velocity="1"/></joint>`
writeFileSync(
  join(xacroWs, 'xbot_macros', 'urdf', 'arm.xacro'),
  '<?xml version="1.0"?>\n<robot xmlns:xacro="http://wiki.ros.org/xacro">\n' +
    '  <xacro:macro name="xbot_arm" params="dims">\n' +
    '    <link name="base_link"><visual><geometry><box size="0.2 0.2 0.1"/></geometry></visual></link>\n' +
    "    <link name=\"upper\"><visual><origin xyz=\"${dims['upper'] / 2} 0 0\"/><geometry><box size=\"${dims['upper']} 0.08 0.08\"/></geometry></visual></link>\n" +
    '    <link name="fore"><visual><origin xyz="${dims.fore / 2} 0 0"/><geometry><box size="${dims.fore} 0.06 0.06"/></geometry></visual></link>\n' +
    '    <link name="tool0"/>\n' +
    `    ${J('shoulder', 'base_link', 'upper', '0 0 0.1')}\n` +
    `    ${J('elbow', 'upper', 'fore', "${dims['upper']} 0 0")}\n` +
    '    <joint name="flange" type="fixed"><parent link="fore"/><child link="tool0"/><origin xyz="${dims.fore} 0 0"/></joint>\n' +
    '  </xacro:macro>\n</robot>\n',
)

// ---- the gate -------------------------------------------------------------------------------------------------

const { url: URL, vite } = await startServer()
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}
const near = (a, b, tol = 1e-3) => Math.abs(a - b) < tol

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
const alerts = []
page.on('dialog', (d) => {
  alerts.push(d.message())
  void d.accept()
})

/** the newest user part's package, as JSON the page can hand back */
const newest = () =>
  page.evaluate(() => {
    const s = window.__oip.store.getState()
    const pkg = s.userPackages[s.userPackages.length - 1]
    if (!pkg) return null
    const asset = pkg.assets?.find((a) => a.id === 'urdf')
    let gltf = null
    if (asset?.data) {
      const bytes = Uint8Array.from(window.atob(asset.data), (c) => c.charCodeAt(0))
      const len = new DataView(bytes.buffer).getUint32(12, true)
      gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)))
    }
    return { id: pkg.id, name: pkg.name, geometry: pkg.geometry, gltf }
  })

/** the world box of the mesh named `name` (the open part's draft is the only part in its scene), or null */
const renderedBox = (name) =>
  page.evaluate((name) => {
    let found = null
    window.__oip.view.scene.traverse((o) => {
      if (!found && o.name === name && o.isMesh) found = o
    })
    if (!found) return null
    found.updateMatrixWorld(true)
    const e = found.matrixWorld.elements
    const pos = found.geometry.getAttribute('position')
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      const z = pos.getZ(i)
      const w = [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], w[k])
        hi[k] = Math.max(hi[k], w[k])
      }
    }
    return { lo, hi }
  }, name)

try {
  await page.goto(URL, { timeout: 120000 }) // a cold dev server transforms the whole graph on this first load
  await page.waitForSelector('.viewport canvas', { timeout: 25000 })
  await page.waitForFunction(() => !!window.__oip?.controller, null, { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })
  await page.evaluate(() => window.__oip.store.revealPanel('catalog'))

  // A
  await page.getByTestId('catalog-import').click()
  const item = page.getByTestId('catalog-import-robot')
  await item.waitFor({ timeout: 5000 })
  check('A  Import part offers "A robot (URDF)…"', (await item.innerText()).trim() === 'A robot (URDF)…')
  await page.keyboard.press('Escape')

  // B
  const before = await page.evaluate(() => window.__oip.store.getState().userPackages.length)
  await page.getByTestId('catalog-import-robot-input').setInputFiles(pkg)
  await page.waitForFunction((n) => window.__oip.store.getState().userPackages.length > n && !!window.__oip.store.getState().packageEdit, before, { timeout: 60000 })
  const made = await newest()
  check('B  the part is named after the robot', made?.name === 'demo_arm', made?.name)
  const g = made?.geometry
  check(
    'B  a link per URDF link, parented as the joints say',
    JSON.stringify(g?.links.map((l) => [l.name, l.parent ?? null, l.shape.kind])) ===
      JSON.stringify([
        ['base_link', null, 'mesh'],
        ['arm', 'base_link', 'mesh'],
        ['finger', 'arm', 'mesh'],
        ['finger2', 'arm', 'frame'],
        ['tool0', 'finger', 'frame'],
        ['base_link_collision', 'base_link', 'box'],
        ['arm_collision', 'arm', 'box'],
        // no hand in the URDF, so the robot carries the app's tools: a mount on tool0, its grip point and two fingers
        ['toolMount', 'tool0', 'frame'],
        ['gripper', 'toolMount', 'frame'],
        ['fingerA', 'toolMount', 'frame'],
        ['fingerB', 'toolMount', 'frame'],
      ]),
    JSON.stringify(g?.links.map((l) => l.name)),
  )
  check(
    'B  a joint per moving joint, with its limits; the fixed one has none',
    JSON.stringify(g?.joints.map((j) => [j.name, j.link, j.type, j.min, j.max])) ===
      JSON.stringify([
        ['shoulder', 'arm', 'revolute', -2, 2],
        ['slide', 'finger', 'prismatic', 0, 0.05],
        ['slide2', 'finger2', 'prismatic', 0, 0.05],
        ['toolGrip', 'fingerA', 'prismatic', -0.05, 0.05],
        ['toolGrip2', 'fingerB', 'prismatic', -0.05, 0.05],
      ]),
    JSON.stringify(g?.joints),
  )
  check('B  the part is posable (the teach gizmo)', g?.posable === true)
  const robotParams = await page.evaluate((id) => {
    const p = window.__oip.getPackage(id)
    return { robot: /robot:/.test(p.behavior) && /ctx\.robot\.step\(\)/.test(p.behavior), columns: p.params.waypoints?.columns, jobs: p.params.jobs?.type, tool: p.geometry.tool }
  }, made?.id)
  check(
    'B  it is a robot: the controller drives the arm to tool0, with waypoints (a column per arm joint) and jobs',
    robotParams.robot && JSON.stringify(robotParams.columns) === JSON.stringify(['J1 °', 'J2 mm']) && robotParams.jobs === 'numberList' && robotParams.tool === 'tool0',
    JSON.stringify(robotParams),
  )
  check('B  the GLB has one node per drawn link', JSON.stringify(made?.gltf?.nodes.map((n) => n.name)) === JSON.stringify(['base_link', 'arm', 'finger']), JSON.stringify(made?.gltf?.nodes))
  check('B  nothing to report, so no message', alerts.length === 0, alerts.join(' | '))

  // C
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000 })
  await page.waitForFunction(() => {
    let n = 0
    window.__oip.view.scene.traverse((o) => {
      if (o.isMesh && (o.name === 'arm' || o.name === 'base_link' || o.name === 'finger')) n++
    })
    return n >= 3
  }, null, { timeout: 30000 })
  const base = await renderedBox('base_link')
  const arm = await renderedBox('arm')
  const finger = await renderedBox('finger')
  const fmt = (b) => (b ? `${b.lo.map((v) => v.toFixed(3))} .. ${b.hi.map((v) => v.toFixed(3))}` : 'not drawn')
  // the draft stands on the origin: URDF x stays x, URDF z is up (y), URDF y is -z
  const at = (b, lo, hi) => !!b && lo.every((v, k) => near(b.lo[k], v)) && hi.every((v, k) => near(b.hi[k], v))
  check('C  the STL base, in millimetres, is a 0.2 m cube on the floor', at(base, [-0.1, 0, -0.1], [0.1, 0.2, 0.1]), fmt(base))
  check('C  the COLLADA arm, in centimetres and Z up, runs 0.5 m along +X from the shoulder', at(arm, [0, 0.15, -0.05], [0.5, 0.25, 0.05]), fmt(arm))
  check('C  the box primitive sits at the arm\'s end, its visual origin applied', at(finger, [0.5, 0.19, -0.01], [0.54, 0.21, 0.01]), fmt(finger))
  const colors = made?.gltf?.materials.map((m) => m.pbrMetallicRoughness.baseColorFactor.map((v) => +v.toFixed(2)).join(' '))
  // both colours are sRGB in their files, so 0.5 grey is 0.21 linear and the COLLADA file's 0.8 red is 0.6
  check('C  the STL takes the URDF colour, the COLLADA file keeps its own red', colors?.includes('0.21 0.21 0.21 1') && colors?.includes('0.6 0.01 0.01 1'), JSON.stringify(colors))

  // D
  const b = g?.bounds
  check('D  the bounds are the rest pose\'s', !!b && near(b.length, 0.64) && near(b.width, 0.2) && near(b.top, 0.25) && near(b.bottom, 0) && near(b.centerX, 0.22), JSON.stringify(b))

  // E
  await page.evaluate(() => window.__oip.controller.closePartScene())
  const before2 = await page.evaluate(() => window.__oip.store.getState().userPackages.length)
  await page.locator('input[type=file][accept*=".urdf"]').setInputFiles(join(pkg, 'urdf', 'demo_arm.urdf'))
  await page.waitForFunction((n) => window.__oip.store.getState().userPackages.length > n, before2, { timeout: 60000 })
  await page.waitForTimeout(200)
  const lone = await newest()
  check('E  a lone .urdf imports what it holds: the finger box, no meshes', JSON.stringify(lone?.gltf?.nodes.map((n) => n.name)) === JSON.stringify(['finger']), JSON.stringify(lone?.gltf?.nodes))
  const said = alerts.at(-1) ?? ''
  check('E  ...and says which meshes it could not find', /3 mesh files were not found/.test(said) && /Import the folder/.test(said), said)

  // F
  await page.evaluate(() => window.__oip.controller.closePartScene())
  const before3 = await page.evaluate(() => window.__oip.store.getState().userPackages.length)
  await page.locator('input[type=file][accept*=".urdf"]').setInputFiles(join(dir, 'macro.urdf'))
  await page.waitForFunction((n) => window.__oip.store.getState().userPackages.length === n, before3, { timeout: 5000 })
  await page.waitForTimeout(500)
  const refused = alerts.at(-1) ?? ''
  check('F  a xacro whose include is missing says which file', /arm\.xacro is not in the folder/.test(refused) && (await page.evaluate(() => window.__oip.store.getState().userPackages.length)) === before3, refused)

  // H
  const before4 = await page.evaluate(() => window.__oip.store.getState().userPackages.length)
  const alertsBefore4 = alerts.length
  await page.getByTestId('catalog-import-robot-input').setInputFiles(xacroWs)
  const models = page.locator('[data-testid^="catalog-import-arg-"]')
  await models.first().waitFor({ timeout: 30000 })
  const offered = (await models.allInnerTexts()).map((s) => s.trim())
  check('H  a model argument with no model asks which, from the YAML folders', JSON.stringify(offered) === JSON.stringify(['model: m1', 'model: m2']), JSON.stringify(offered))
  await models.nth(1).click()
  const options = page.locator('[data-testid^="robot-option-"]')
  await options.first().waitFor({ timeout: 30000 })
  const asked = await options.evaluateAll((els) => els.map((e) => `${e.dataset.testid.slice('robot-option-'.length)}=${e.checked}`))
  check('H  then asks about the switch that adds a link, at its default, and not the simulator one', JSON.stringify(asked) === JSON.stringify(['tip=false']), JSON.stringify(asked))
  await options.first().check()
  await page.getByTestId('robot-options-import').click()
  await page.waitForFunction((n) => window.__oip.store.getState().userPackages.length > n, before4, { timeout: 60000 })
  await page.waitForTimeout(200)
  const fromXacro = await newest()
  const xj = fromXacro?.geometry?.joints?.filter((j) => !j.cosmetic && !j.mimic)
  check('H  the picked model imports as a robot named for what was picked', fromXacro?.name === 'xbot (m2, tip)' && JSON.stringify(xj?.map((j) => j.name)) === JSON.stringify(['shoulder', 'elbow']), `${fromXacro?.name} ${JSON.stringify(xj?.map((j) => j.name))}`)
  const elbow = fromXacro?.geometry?.links?.find((l) => l.name === 'fore')
  check("H  its dimensions come from the model's YAML (m2: upper arm 0.6 m)", !!elbow && near(elbow.offset[0], 0.6), JSON.stringify(elbow?.offset))
  check('H  the box primitives are drawn, the tip with them, nothing to report', JSON.stringify(fromXacro?.gltf?.nodes.map((n) => n.name)) === JSON.stringify(['base_link', 'upper', 'fore', 'tip']) && alerts.length === alertsBefore4, `nodes ${JSON.stringify(fromXacro?.gltf?.nodes.map((n) => n.name))}, alerts ${alerts.slice(alertsBefore4).join(' | ')}`)
  await page.evaluate(() => window.__oip.controller.closePartScene())

  // G
  const slide2 = g?.joints.find((j) => j.name === 'slide2')
  check('G  the second finger follows the first (mimic)', JSON.stringify(slide2?.mimic) === JSON.stringify({ joint: 'slide' }), JSON.stringify(slide2))
  const colliders = g?.links.filter((l) => /_collision$/.test(l.name)).map((l) => ({ name: l.name, hidden: l.hidden, size: l.shape.size, offset: l.offset.map((v) => +v.toFixed(3)) }))
  check(
    'G  the base collides as its box, the arm as the box around its collision mesh, both hidden',
    JSON.stringify(colliders) ===
      JSON.stringify([
        { name: 'base_link_collision', hidden: true, size: [0.2, 0.2, 0.2], offset: [0, 0, 0.1] },
        { name: 'arm_collision', hidden: true, size: [0.5, 0.1, 0.1], offset: [0.25, 0, 0] },
      ]),
    JSON.stringify(colliders),
  )
  await page.evaluate(() => window.__oip.controller.closePartScene())
  await page.evaluate((robotId) => {
    const { store } = window.__oip
    const robot = window.__oip.getPackage(robotId)
    const box = window.__oip.getPackage('oip.box')
    // a 6 cm box over the base, clear of the arm (which starts at x = 0)
    store.loadScene({
      parts: [
        { id: 'robot1', type: 'part', packageId: robot.id, position: [0, 0, 0], rotationY: 0, params: {} },
        { id: 'box1', type: 'part', packageId: box.id, position: [-0.06, 0.6, 0], rotationY: 0, params: { length: 0.06, height: 0.06, width: 0.06 } },
      ],
      packages: [robot, box],
    })
    store.setState({ selectedIds: [] })
  }, made.id)
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => (window.__oip.controller.lastFrame?.simTime ?? 0) > 2, null, { timeout: 30000 })
  const boxY = await page.evaluate(() => {
    const f = window.__oip.controller.lastFrame
    const j = f.partIds.indexOf('box1')
    return j < 0 ? null : f.positions[j * 3 + 1]
  })
  // on the 0.2 m base its centre is at 0.23; through it, on the floor, at 0.03
  check('G  running, a box dropped on the base rests on its collider', boxY !== null && near(boxY, 0.23, 0.01), `box centre at y = ${boxY?.toFixed(3)}`)
  await page.evaluate(() => window.__oip.controller.stop())

  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000 })
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} catch (e) {
  failures++
  console.log(`FAIL  harness: ${e?.message ?? e}`)
} finally {
  await browser.close()
  vite.kill()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
