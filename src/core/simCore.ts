// The authoritative simulation contract.
//
// A SimCore is a deterministic, fixed-timestep simulation that is the single source of truth for
// both renderable state and measurements. The presentation layers (three.js renderer, React editor)
// and any host (web worker, native shell, server) consume a SimCore and never simulate
// independently. That separation lets the sim move to another host (worker → native module →
// headless server) without touching the UI, and keeps measurements consistent across surfaces.
//
// Determinism is a requirement because users act on a digital twin's throughput and cycle-time
// numbers. Those numbers are only trustworthy if the same scene and inputs reproduce the same run.
// So a SimCore must advance on a fixed internal timestep (never wall-clock dt) and must not use
// Math.random (use a seeded Rng). See docs/architecture.md.

/**
 * Aggregate measurements a digital twin reports - the numbers users act on. Reproducible because the
 * sim is deterministic. Time is simulated time (derived from the step count), never wall-clock.
 */
export interface Measurements {
  /** simulated time elapsed in seconds (stepCount / simHz), not wall clock */
  simSeconds: number
  /** total cargo items spawned (infed) over the run */
  spawnedTotal: number
  /** total cargo items that completed the line (removed by a despawner) */
  completedTotal: number
  /** cargo items currently on the line - work-in-process (WIP) */
  liveCount: number
  /** the headline KPI: line completions per minute of simulated time */
  throughputPerMin: number
  /** infeed rate: spawns per minute of simulated time */
  spawnThroughputPerMin: number
  /** average time an item takes spawn→despawn (seconds); 0 until the first completion */
  avgCycleSeconds: number
}

/**
 * A deterministic, fixed-timestep simulation and the single authoritative source of state +
 * measurements.
 *
 * - `step()` advances exactly one fixed tick. There is intentionally no `dt`: the timestep is
 *   internal and constant, which is what makes a run reproducible.
 * - `frame()` returns the current renderable state for the presentation layer to draw.
 * - `measurements()` returns the aggregate numbers a twin reports.
 *
 * Implementations must not read wall-clock time or call Math.random inside the stepped path:
 * non-determinism makes measurements unrepeatable. Use a seeded `Rng` for any randomness.
 */
export interface SimCore<TState> {
  step(): void
  frame(): TState
  measurements(): Measurements
}
