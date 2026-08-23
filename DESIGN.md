# DESIGN — Gridpulse

## Point of view

Gridpulse should feel like a piece of instrument hardware you play, not a website you operate. The register is dense, tactile, confident: a dark panel that recedes so the step grid can dominate, controls grouped the way they would be silkscreened on a device — transport top-left, grid centre and huge, per-track strip on the left of the grid, sound parameters in a right-hand bay, mixer along the bottom. Every element earns its pixels; there is no hero section, no cards, no marketing surface. We reject both failure modes with equal force: the generic SaaS dashboard (rounded white cards, soft shadows, indigo buttons) and the neon-cyberpunk synth cliché (glow everywhere, purple gradients, sci-fi fonts). The reference tradition is the front panel of a well-designed groovebox: matte surfaces, one accent colour used sparingly for state, LED-bright track colours only where they carry information.

## Layout

```
+------------------------------------------------------------------+
| TRANSPORT  [play][stop] BPM [120.0] TAP | swing | sig | metro    |
+--------+---------------------------------------------------------+
| TRACK  |                    STEP GRID                            |
| STRIPS |   (rows = tracks, columns = steps, beats accented)      |
| +names |                                                         |
+--------+-------------------------------------+-------------------+
| MIXER (faders, pan, mute/solo, meter)         | SOUND BAY         |
|                                               | (selected track)  |
+-----------------------------------------------+-------------------+
| STATUS BAR: context state · MIDI state · headroom · hint line     |
+------------------------------------------------------------------+
```

The grid is the largest element at every viewport size; panels never push it below ~55% of viewport height.

## Step grid geometry

- Cell: **28 × 28 px** desktop, **40 × 40 px** under `pointer: coarse`. Gap: **3 px** between cells.
- Beat grouping: every 4th step (step index %4==0) gets an extra **6 px** gap before it and a full-height beat rule behind the column. Every 16th step (bar start) gets **10 px** gap plus a brighter bar rule. Position is readable without counting cells.
- Row: track strip (56 px wide) + cells. Rows separated by 6 px.
- Pattern length changes re-render columns in place; the grid container reserves width by `max-pattern-length` so **no layout shift** occurs when lengths change (columns beyond length render as dimmed placeholders).
- Per-track length is shown by a hard end-cap rule after that track's last active column.

## Step state visual language

Every state is a composable overlay so all states are simultaneously readable:

| State | Treatment |
| --- | --- |
| Off | Hollow cell: 1 px border `--cell-off-border`, transparent fill. |
| On | Filled with track colour; fill luminance maps velocity (0→`track-dim`, 1→full). |
| Accented (velocity ≥ 0.75) | 2 px inner top highlight bar in near-white over the fill. |
| Low probability (< 1) | Diagonal hatch overlay (`repeating-linear-gradient`, fg at 45°, 35% alpha) **plus dashed border**. Readable on top of any fill. |
| Ratcheted (> 1 repeat) | Right-edge tick marks: one 2×8 px tick per extra repeat (max shown: 7). |
| Nudged (≠ 0 ms) | Corner triangle in the cell's top-left pointing left (early) or right (late). |
| Currently playing | Column underlay: playing column gets `--col-active` wash; the exact cell gets a 1.5 px outline in `--fg`. No scale/bounce animation. |
| Selected (copy range / focused cell) | Inset 1 px outline `--focus-ring` offset −2 px. |

Composability check: *on + accented + low-probability + nudged* = velocity-mapped fill + top highlight + hatch/dash overlay + corner triangle — all four legible at once. Verified per theme by programming exactly that step.

Playhead: continuous 2 px vertical line spanning all rows, translated via `transform` (compositor-only). Under `prefers-reduced-motion`: the discrete column highlight replaces it (column jumps per step, no sub-step motion).

### Playhead alignment method (stated, measured)

Position derives from `AudioContext.currentTime` mapped through the same musical-time↔seconds function the scheduler uses — never from a wall-clock timer or frame counter. A constant visual lead of `outputLatency` seconds compensates output latency; the residual offset is measured offline: render a pattern through `OfflineAudioContext`, detect onset sample positions of scheduled hits, compare to ideal grid samples. Interactive jitter is measured by timestamping rAF reads against audio time. Numbers live in README/AUDIT; nothing is claimed without this method.

## Controls

- **Knobs** for sound/effect parameters (dense hardware idiom; 20+ params must fit one bay without scrolling). 36 px diameter, arc indicator from 7 o'clock, value readout replaces label while dragging and for 1 s after release.
- **Sliders** only for mixer volume faders — vertical level is the one place a linear metaphor is stronger than rotary (mixing convention), 96 px tall.
- Fine adjust: mouse drag = coarse; `Shift`+drag = ×0.1 sensitivity; double-click = reset to default; focus + arrow keys = ±1 unit (`Shift` = ×0.1); `Home/End` = min/max. All knobs/faders are real `<input>` semantics or fully ARIA-slider patterned.
- Buttons: transport 32 px square, icon glyphs drawn as inline SVG paths (no emoji, no font icons).
- Pan knobs centred at 12 o'clock; bipolar values show L/R units.

## Mixer & FX layout

Bottom strip: per-track channel — fader, pan knob, M/S toggles, peak meter (real post-fader RMS+peak, 30 fps max refresh, decaying hold). Sound bay shows selected track's FX chain in fixed order with a static signal-flow diagram printed above:

```
voice → distortion → filter → compressor → [delay send] → [reverb send] → pan → fader → master
```

Delay and reverb are per-track sends into two shared returns (delay tempo-synced to transport). Each FX block has an on/off toggle rendered as a lit LED dot next to its name.

## Type & spacing

- Fonts: UI text — system-ui stack; numeric readouts and labels — ui-monospace stack (`Consolas` fallback), tabular figures.
- Scale: 11 px uppercase labels (+0.08em tracking) · 13 px body · 15 px values · 20 px section titles. Nothing larger; hierarchy comes from weight and case.
- Spacing base 4 px: panel padding 16, group gap 24, control gap 8, inline gap 4.
- Borders: 1 px `--line`; corner radius 3 px on panels, 2 px on cells (crisp, not pillowy).

## Colour tokens

Roles are tokens; themes override tokens only. Per-track colours are a separate palette referenced by role token per theme.

| Token | Dark (default) | Light | High-contrast |
| --- | --- | --- | --- |
| --bg-app | #141414 | #ECEAE4 | #000000 |
| --bg-panel | #1D1D1B | #F7F5EF | #0A0A0A |
| --bg-sunken | #161615 | #E2DFD7 | #000000 |
| --fg | #E9E6DD | #1C1B18 | #FFFFFF |
| --fg-dim | #9A968B | #6A665C | #C8C8C8 |
| --line | #33322E | #C9C4B8 | #585858 |
| --accent | #FFB347 (amber) | #B25E00 | #FFD24D |
| --accent-fg | #141414 | #FFFFFF | #000000 |
| --col-active | rgba(255,179,71,.10) | rgba(178,94,0,.08) | rgba(255,210,77,.14) |
| --cell-off-border | #5C594E | #9C9484 | #767676 |
| --focus-ring | #FFD98A | #7A3D00 | #FFE9A8 |
| --danger | #FF6B57 | #B32300 | #FF8A78 |
| --ok | #6FD08C | #1B7A38 | #8CF0A8 |

Track palette (8, per theme; chosen for deuteranopia safety — hue spread avoids red/green pairs at equal lightness, lightness steps differ within pairs):

| Slot | Dark | Light | High-contrast |
| --- | --- | --- | --- |
| t1 amber | #FFB347 | #A85C00 | #FFD24D |
| t2 blue | #5CA8FF | #1D5FBF | #6FB5FF |
| t3 pink | #FF6FA5 | #B02E62 | #FF8FBB |
| t4 teal | #3FBFB4 | #0E7A72 | #63DED4 |
| t5 yellow | #E3D44C | #8A7D00 | #F2E668 |
| t6 violet | #B48CFF | #6640C7 | #CBA8FF |
| t7 cream | #EDE3C8 | #7A6F52 | #FFF3D6 |
| t8 sky | #8FD8E8 | #23707F | #AEE6F2 |

Rows also carry name labels — colour never encodes alone. Contrast: every fg/bg pair above meets AA for its use (labels ≥4.5:1, large fills ≥3:1 against panel).

## Motion rules

- Control feedback ≤ 150 ms ease-out. Step toggle: instant state change, **no bounce**.
- Playhead: continuous transform updates at display rate; reduced-motion swaps to discrete column indicator.
- Panel open/close: none. Toasts slide 8 px fade 150 ms.
- Meter ballistics are measurement (attack/release constants), not decoration.

## Required states

| State | Treatment |
| --- | --- |
| Empty project | Never blank: first load seeds a default kit + starter pattern; hint line in status bar ("Space to play · click cells"). |
| Loading (project/file) | Sunken overlay on the affected panel with mono "LOADING…" label; grid stays interactive if unaffected. |
| Audio blocked by browser | Status bar turns `--accent` with "AUDIO SUSPENDED — CLICK TO START" button; transport disabled until gesture completes resume. |
| Sample decode failed | Toast names the file and reason ("cannot decode kick.wav: not valid audio"), sampler slot keeps previous buffer or shows empty; no modal dead-end. |
| No MIDI support / permission denied | Settings panel shows inline mono note ("Web MIDI unavailable in this browser" / "permission denied"); everything else unaffected. |
