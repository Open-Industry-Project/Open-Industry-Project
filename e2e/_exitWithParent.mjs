// Preloaded into a process an e2e script starts (node --import): it exits once the script that started it is gone.
// A script that is killed outright runs no teardown, and the server it started would otherwise run on.
const parent = process.ppid
setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch {
    process.exit(0)
  }
}, 2000).unref()
