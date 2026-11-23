// The processes an e2e script starts (a dev server, a collab server): each is torn down with everything it started,
// and at exit whatever the script does or fails to do in its own teardown.
import { spawn, spawnSync } from 'node:child_process'

/** PIDs this script started and has not stopped */
export const spawnedPids = new Set()

/** Stop `pid` and everything it started. Synchronous, so a port is free before the caller goes on or exits. */
export function treeKill(pid) {
  if (!pid) return
  spawnedPids.delete(pid)
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { /* not a group leader, or already gone */ }
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

// exit handlers must be synchronous, and taskkill /F is
let cleanupInstalled = false
export function installCleanup() {
  if (cleanupInstalled) return
  cleanupInstalled = true
  const killAll = () => { for (const pid of [...spawnedPids]) treeKill(pid) }
  process.on('exit', killAll)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { killAll(); process.exit(1) })
  }
}

/** child_process.spawn, with kill() a tree-kill and the teardown at exit */
export function ownSpawn(command, args, options) {
  const child = spawn(command, args, options)
  const pid = child.pid
  if (pid) spawnedPids.add(pid)
  installCleanup()
  child.kill = () => { treeKill(pid); return true }
  return child
}
