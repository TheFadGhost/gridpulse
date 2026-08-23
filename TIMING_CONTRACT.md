# TIMING CONTRACT

This document is the single source of truth for time in Gridpulse. Every module that produces or consumes musical time implements exactly these definitions. **No UI code may schedule audio events.** UI dispatches intents; the scheduler is the only writer of audio event times.

## Clock domains

- **Audio time**: `AudioContext.currentTime`, seconds, float64. The only clock used to schedule sound.
- **Musical time**: position in beats (quarter notes), float64, relative to transport start.
- Wall-clock (`performance.now`, `Date.now`) is never used to compute an event time.

## Transport model

The transport keeps an append-only list of anchors: `anchors = [{beat: b_i, time: t_i}]`. `t_0` is the start time. A tempo change taking effect at musical position `b` appends `{beat: b, time: beatsToSeconds(b)}` computed from the previous anchor — already-scheduled events are never moved.

- `beatsToSeconds(b)` = piecewise-linear integral of `60/bpm` over the anchor list.
- `secondsToBeats(t)` = its inverse.
- `swing`: applied at the *event* level, not the grid level: for a 16th-note step with index parity odd within a beat, delay `= swingAmt * secondsPerBeat/4`, `swingAmt ∈ [0, 0.6]` (0 = straight). Even steps and non-16th subdivisions are unaffected. Formula is normative and tested directly.

## Scheduler

- Lookahead window: `LOOKAHEAD = 0.18 s`. Tick period: `TICK_MS = 30`.
- Ticks come from a Web Worker timer (`ticker.worker.js`) so background-tab timer throttling cannot starve scheduling. Fallback: main-thread interval if Worker creation fails; when `document.hidden` and fallback is active, lookahead widens to `0.6 s`.
- Each tick: let `[w0, w1] = [now, now + LOOKAHEAD]`. The scheduler advances its play cursor through the musical timeline, materializing every step event whose final audio time falls inside the window, sorted by time.
- An **Event**:
  ```js
  { trackId, patternId, stepIndex, note /* midi or null */, velocity, // 0..1
    ratchet /* 1..8 */, repeat /* 0..ratchet-1 */, nudgeMs /* -40..40 */,
    time /* audio s = gridTime(step) + swing(step) + nudge + repeat*(stepSpan/ratchet) */ }
  ```
- Ratchets subdivide the remaining step duration into `ratchet` equal repeats starting at the step time.
- Probability resolves once per `(cycleCount, stepIndex)` using a seeded RNG (mulberry32, seed = project seed ⊕ hash(patternId, cycle)). Determinism: same seed + same project ⇒ identical event stream (tested over simulated hours).
- Per-track pattern lengths: each track loops over its own length; global cycle length = LCM of active track lengths. Events carry their own pattern/track context. A live performance layer may attach `repeatOverride: {step, velocity?, ratchet?}` to a view track; when present it forces that step on (probability 1) with the given ratchet — this is how the step-repeat control retriggers cells without leaving the scheduler.
- Tempo changes requested mid-playback take effect at the next unmaterialized boundary — no dropped or duplicated events (tested).
- Stop flushes nothing already scheduled (≤180 ms tail is musically correct); Start schedules from `now + 0.06`.

## Voice contract

Voices implement `trigger(ctx, destination, event, params, helper)` and schedule all nodes strictly at `event.time` (absolute audio time). Voices must not read `ctx.currentTime` to decide *when* a note happens. Metronome is a voice like any other. Cleanup: every created node is either auto-GC'd per spec after onended where applicable or explicitly disconnected via the voice's returned teardown set; the graph audit counts nodes across pattern switches.

## Playhead

UI reads `transport.getPlayhead()` → `{beat, fraction}` computed from `ctx.currentTime` (minus `baseLatency + outputLatency` visual compensation, clamped ≥ 0). Drawn each animation frame as a compositor transform. Reduced motion renders discrete current-step highlight instead.

## Measurement obligations

Any timing claim in docs must state method + environment. Baselines recorded in AUDIT.md:
1. **Drift**: scheduler run against mocked clock for a simulated hour ⇒ last event ideal vs actual delta == 0 (exact math, asserted).
2. **Jitter**: distribution of `scheduledTime − idealGridTime` over long runs (must be identically 0 in the mock; measured live via onset detection in OfflineAudioContext renders).
3. **Playhead offset**: rendered onsets vs playhead position at those samples, reported in ms.
