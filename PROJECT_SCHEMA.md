# PROJECT SCHEMA v1

Project files are JSON. `src/core/schema.js` exports `validateProject(obj)` returning `{ok, errors[], project}`. Loaders must validate before use; unknown fields are preserved but ignored (forward compat).

```jsonc
{
  "format": "gridpulse-project",
  "version": 1,
  "name": "string",
  "seed": 123456789,                  // uint32, RNG seed
  "bpm": 120,                          // 20..333, one decimal allowed
  "swing": 0,                          // 0..0.6
  "timeSig": { "num": 4, "den": 4 },   // num 2..16, den ∈ {2,4,8,16}
  "metronome": { "enabled": false, "division": 4, "gain": 0.5 },
  "tracks": [{
    "id": "t-kick",                    // string, unique
    "name": "Kick",
    "type": "drum" | "synth" | "sampler",
    "colorSlot": 1,                    // 1..8 index into palette
    "length": 16,                      // steps, 1..patternLength
    "params": { ... },                 // type-specific, validated per type
    "mixer": { "volume": 0.8, "pan": 0, "mute": false, "solo": false }, // vol 0..1.2, pan -1..1
    "fx": {
      "drive":   { "on": false, "amount": 0.3 },          // amount 0..1
      "filter":  { "on": false, "type": "lowpass", "cutoff": 8000, "q": 0.7 }, // cutoff 30..18000
      "comp":    { "on": false, "threshold": -18, "ratio": 3, "attack": 0.006, "release": 0.12 },
      "delay":   { "on": false, "division": 3, "feedback": 0.35, "mix": 0.25 }, // division in 16ths
      "reverb":  { "on": false, "size": 0.5, "mix": 0.2 }  // size 0..1 → generated IR length
    }
  }],
  "patterns": [{
    "id": "p1", "name": "A", "length": 16,             // length 1..64
    "steps": {
      "<trackId>": [                                    // array length = pattern.length
        { "on": true, "vel": 0.9, "prob": 1, "ratchet": 1,
          "nudge": 0,                                   // ms, -40..40
          "note": 36 }                                  // melodic tracks only; null otherwise
      ]
    }
  }],
  "song": { "chain": ["p1", "p1", "p2"], "mode": "pattern" | "song" }
}
```

Rules:

- Step arrays are dense and exactly `pattern.length` long; defaults for missing optional fields are the documented zeros.
- `vel ∈ [0,1]`, `prob ∈ [0,1]`, `ratchet ∈ [1,8]`, `nudge ∈ [-40,40]` int ms, `note ∈ [0,127] | null`.
- Validation clamps nothing silently: out-of-range values are errors, not warnings. Extra step fields round-trip untouched.
- Save/load round-trip equality is tested field-by-field including every per-step parameter.

Sampler tracks additionally keep `"sample": {"name": "...", "data": "<base64>"}` only inside `.local` saves if user opts in ("embed samples"); exported projects by default reference name only and load expects the file. This keeps repos and shared JSON small and avoids shipping audio of unknown provenance.
