# PLAN

Feature ideation judged against three tests: serves the core purpose (programming and performing patterns); finishable to the same quality bar; stays out of second-product territory.

## Accepted (first-class features)

| Feature | Reason |
| --- | --- |
| Keyboard shortcuts for transport and step entry | Core purpose: performing patterns without the mouse; cheap once the keymap exists. |
| Preset kit + original preset patterns | Sensible defaults so first sound is within five seconds; content is original, synthesized. |
| Undo/redo (snapshot-based, depth 100) | Step editing is destructive and rapid; snapshots are simple and reliable. |
| Randomize / humanize with bounded ranges | Core creative workflow for programming patterns fast. |
| Step-repeat performance control | Directly extends performing on the grid (hold to retrigger). |
| Real post-fader peak metering per track | Audits demand meters measure something real; decorative meters are banned. |
| Onboarding hint line + starter pattern audible on first load | Five-second-to-sound requirement. |
| Helpful sample-decode errors | File input failure paths are certain; must not dead-end. |
| Grid accessibility + documented key map | The grid is the product; keyboard-only programming must work end to end. |
| CPU/scheduler-headroom indicator | Long sessions need a trust signal tied to the real scheduling margin. |
| Themes (dark, light, high-contrast) as token overrides | Accessibility and long-session comfort without forking styles. |
| Copy/paste of steps and whole tracks between patterns | Core pattern workflow. |
| Metronome with selectable division | Practicing/performing tool, trivially served by the voice interface. |

## Rejected (second products / out of scope)

| Feature | Reason |
| --- | --- |
| Audio-track recording and timeline editing | Full DAW territory; different product. |
| Cloud project sharing with accounts | Server product, auth surface, moderation; not a sequencer feature. |
| Sample marketplace/library browsing | Content business, licensing burden; users load their own files. |
| Collaborative networked jamming | Realtime networking is its own hard product; local latency-free focus wins. |
| MIDI file import | Export covers the interop need; parsing arbitrary SMFs is a second parser product. |
| Plugin (VST/AU) hosting | Impossible in-browser sandbox; out of scope by platform. |
| Per-note automation lanes | Expands the data model into DAW editing; per-step params already cover groove. |
| Mobile native packaging | Responsive layout yes; store packaging is a distribution product. |
| Song-level per-step automation of tempo | Tempo map inside patterns is enough; song arranger stays pattern-chain simple. |

## Release ladder

- v0.1.0 — a pattern plays in time with synthesized drums (measured, not assumed).
- minors per major subsystem landing (synth+sampler, FX+mixer, piano roll, MIDI, song mode, WAV render, themes/a11y).
- v1.0.0 only after a clean external audit (AUDIT.md zero findings) including timing measurements.
