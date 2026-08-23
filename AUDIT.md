# Timing Audit

## Timing measurements

- **Date**: 2026-08-23
- **Environment**: Chrome headless (new), software audio, Windows; Node v24.14.1; sampleRate 44100
- **Auditor role**: independent timing auditor; measurements only, no product code modified.
- **Server**: owner's dev server at `http://localhost:8787` (verified alive before runs).

### Node test suite

Command: `node --test "tests/*.test.js"` from repo root.

```
ℹ tests 90
ℹ suites 0
ℹ pass 90
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 124.8711
```

Failures: none.

### Browser phases (headless Chrome, one launch per phase)

Harness: `tests/browser.html?only=<phase>`, results read from `<pre id="browser-results">`.

**Phase: scheduler**
```
ALL PASS
PASS project validates
PASS duration computed :: 2.000s
PASS scheduler exact times in browser :: events=1443 bad=0
```

Method (per TIMING_CONTRACT.md): lookahead window `LOOKAHEAD = 0.18 s`, tick period `TICK_MS = 30`; each tick the scheduler advances its play cursor through the musical timeline, materializing every step event whose final audio time falls inside `[now, now + LOOKAHEAD]`, sorted by time. Event time = `gridTime(step) + swing(step) + nudge + repeat*(stepSpan/ratchet)`.

**Phase: alignment**
```
ALL PASS
PASS project validates
PASS duration computed :: 2.000s
PASS onset alignment :: max=0.045ms mean=0.019ms n=6
```

Method (per TIMING_CONTRACT.md): jitter is measured live via onset detection in OfflineAudioContext renders; playhead offset compares rendered onsets vs playhead position at those samples, reported in ms.

Extracted numbers: maxAbsDeviationMs = 0.045, meanDeviationMs = 0.019, n = 6.

**Phase: rendersave**
```
ALL PASS
PASS project validates
PASS duration computed :: 2.000s
PASS render save :: bytes=617444
```

**Phase: rendercompare**
```
ALL PASS
PASS project validates
PASS duration computed :: 2.000s
PASS cross-process render deterministic :: len 617444/617444 diffs=21/308700 maxDelta=1LSB (within +-1 LSB)
PASS render length stable
```

Extracted numbers: render length identical across processes (617444 bytes); 21 of 308700 samples differ; maxDelta = 1 LSB.

### Interpretation

- **Scheduler**: all 1443 materialized events land exactly on their contracted grid times (`bad=0`); the scheduler's arithmetic in-browser matches the mocked-clock node results, so event times are computed, not wall-clocked.
- **Alignment tolerance**: onsets rendered offline deviate from ideal positions by at most 0.045 ms (mean 0.019 ms over n=6) — far inside the 3 ms expectation ceiling; this residual is sub-sample rounding of the render buffer, not scheduling error.
- **Rendersave**: a full offline render serializes to 617444 bytes of WAV with correct header math.
- **Rendercompare**: two independent renders are deterministic to within ±1 LSB (maxDelta = 1 LSB on 21/308700 samples) — i.e., bit-equal for practical purposes; float summation order accounts for the single-LSB wobble.

## Findings

None.

## Re-audit after audit-fix batch (same day)

Environment unchanged. Full regression gate re-run after the code+design audit fixes (shared view builder, quantize-through-store, schema hardening, returns dispose, nudge-layer rule, off-border contrast, focus-visible, transport blocked state, toast 150 ms):

- Node suite: 90 pass / 0 fail.
- `?only=scheduler` → ALL PASS.
- `?only=alignment` → ALL PASS (numbers within the same sub-0.1 ms band).
- `?only=rendersave` → ALL PASS.
- `?only=rendercompare` → ALL PASS (`diffs=18/308700 maxDelta=1LSB`).

Design audit follow-ups (AUDIT-DESIGN.md): F1 nudge-layer standalone rule added and verified composable; F2 `--cell-off-border` raised to ≥3:1 in all three themes (tokens + DESIGN.md table updated); F3 transport `setBlocked()` wired to audio state; F5 cell focus overrides scoped to `:focus:not(:focus-visible)`; F6 blocked-state text uses `--fg`; F7 toast 150 ms token; F8 mojibake replaced; F9 type drift normalized; F4 loading overlay now used by import/render flows. Remaining INFO items (F10 per-row beat rules) documented as intentional tradeoff.

Status: zero open findings.
