# AUDIT-DESIGN — Gridpulse external design & accessibility audit

Auditor: external (wrote none of this code). Normative reference: `DESIGN.md`, including its Required states list ("Required and audited").
Method: static read of `styles/*.css`, `src/ui/*.js`, `src/app/main.js`, `src/audio/samplelib.js`; WCAG contrast ratios computed from `styles/tokens.css` values; runtime DOM dumped via headless Chrome against http://localhost:8787 (boot-error check clean; 131 `.gp-cell` rendered).

---

## Findings

### F1 - HIGH - Nudged state renders nothing unless the cell is also ratcheted (composability violation)

Evidence: `--nudge-layer` is defined at `styles/grid.css:66` and set from `[data-nudge-dir]` at `styles/grid.css:145-159`, but it is only *consumed* inside the `[data-ratchet].r2 ... .r8` background stacks (`styles/grid.css:165-250`). No standalone rule paints `var(--nudge-layer)`. `src/ui/grid.js:204-206` sets `data-nudge-dir` independently of ratchet, so any nudged step with `ratchet = 1` (the default; also what keyboard `[` / `]` nudge leaves on an unratcheted step) shows no corner triangle.

DESIGN.md lists Nudged as an independent composable state ("Nudged (!= 0 ms): corner triangle..."), and its composability check "on + accented + low-probability + nudged = ... all four legible at once" fails at default ratchet.

Fix: add before the ratchet blocks:
`.gp-cell[data-nudge-dir] { background-image: var(--nudge-layer); background-repeat: no-repeat; background-size: 8px 8px; background-position: left 2px top 2px; }`
(the ratchet rules already re-declare all three background properties, so they still override cleanly).

### F2 - HIGH (a11y) - Off-cell border below 3:1 UI contrast in every theme

Computed from tokens (WCAG 2.x relative luminance):

| Pair | Dark | Light | High-contrast |
| --- | --- | --- | --- |
| `--cell-off-border` vs `--bg-panel` | **1.35:1** (#35342F/#1D1D1B) | **1.51:1** (#CFC9BC/#F7F5EF) | **2.23:1** (#4A4A4A/#0A0A0A) |

The 1 px hollow border is the sole visual carrier of the Off state (DESIGN.md step-state table), so WCAG 1.4.11 non-text contrast (3:1) fails in dark, light and high-contrast themes. Note: the code matches DESIGN.md's token table byte-for-byte; it is DESIGN.md's own claim ("every fg/bg pair above meets AA for its use... large fills >= 3:1") that is inconsistent with its `--cell-off-border` values. Fix at spec level then code: raise the token (approx #5C594E dark / #9C9484 light / #767676 contrast) or add a second off-state cue (e.g. faint sunken fill).

All other audited pairs pass:

| Pair | Dark | Light | Contrast |
| --- | --- | --- | --- |
| fg vs bg-panel (>=4.5) | 13.53 | 15.80 | 19.80 |
| fg-dim vs bg-panel (>=4.5) | 5.72 | 5.25 | 11.83 |
| accent-fg vs accent (>=4.5) | 10.34 | 4.67 | 14.58 |
| focus-ring vs bg-panel (>=3) | 12.50 | 7.72 | 16.47 |
| danger vs bg-panel (>=3) | 6.02 | 6.10 | 8.63 |
| ok vs bg-panel / bg-sunken (>=3) | 8.91 / 9.55 | 4.95 / 4.06 | 14.28 / 15.14 |

### F3 - MEDIUM - "Transport disabled until gesture completes resume" not implemented

DESIGN.md Required states: audio blocked -> "...transport disabled until gesture completes resume." `updateStatus()` (`src/app/main.js:697-717`) toggles only the status-bar class and unblock button; `src/ui/transport.js` exposes no disable API and play/stop remain enabled while blocked. Audio still starts because `wireFirstGesture()` resumes on first interaction, but the specified treatment is absent. Fix: add `setBlocked(bool)` to transport, setting `.gp-btn` disabled on Play/Stop when `engine.state() !== 'running'`.

### F4 - MEDIUM - Loading required-state defined but unreachable

`.gp-loading` sunken overlay with mono LOADING label exists (`styles/components.css:350-363`) but no JS references it (grep across `src/**`: zero hits). File import, slot load and WAV render surface toasts or a transient disabled button label instead of the specified panel overlay ("Loading (project/file): sunken overlay on the affected panel... grid stays interactive if unaffected"). Fix: wrap slot-load/import/render in show/hide of `.gp-loading` inside the affected panel.

### F5 - MEDIUM - Grid/piano-roll cell keyboard focus ring is not :focus-visible-driven

Injected styles `.gp-grid .gp-cell:focus { outline: none }` (`src/ui/grid.js:33`) and `.gp-pr-cell:focus { outline: none }` (`src/ui/pianoroll.js:59`) override the global `:focus-visible` ring (`styles/base.css:75-78`) by specificity (0,3,0 > 0,1,0), including for keyboard focus. A visible indicator survives only via the selection-coupled inset ring `.gp-cell.is-selected { outline: 1px solid var(--focus-ring) }` (`styles/grid.css:261-264`); if selection is cleared programmatically while focus remains, there is no focus indication, and mouse clicks also produce the same "focus" styling. Fix: delete both overrides (let `:focus-visible` apply) or scope them to `:focus:not(:focus-visible)`.

### F6 - LOW/MEDIUM - Light theme audio-blocked status text slightly under AA

`.is-audio-blocked` colors status text with `--accent` on `--bg-panel` (`styles/components.css:310-312`, `styles/app.css:99`): #B25E00 on #F7F5EF = **4.29:1** for 11 px uppercase mono text (< 4.5). Dark (9.48) and high-contrast (13.74) pass; the CLICK TO START AUDIO button itself passes (white on #B25E00 = 4.67). Fix: use a darker text-safe token for this state in light theme.

### F7 - LOW - Toast duration deviates from motion spec

DESIGN.md Motion rules: toast slide 8 px fade **150 ms**. Implemented at `var(--dur-med)` = 180 ms (`styles/components.css:384-385`, `styles/tokens.css:110`). Direction/distance correct; set toast transitions to a dedicated `--dur-toast: 150ms`.

### F8 - LOW - Mojibake in help dialog UI strings

`src/app/main.js` buildHelp contains double-encoded em dashes rendering literally as "â€" grid â€"" / "â€" mouse modifiers â€"" (confirmed in served DOM dump of `dialog#help`). Visible corrupted glyphs in a rendered dialog; file needs re-saving as UTF-8 (or replace with plain "-").

### F9 - INFO - Type-scale drift at the small end

Declared scale is 11/13/15/20 px ("nothing larger"). Nothing exceeds 20 px (good), but several labels sit below the 11 px floor: `.gp-headname` 10 px, `.gp-msbtn` 9 px (`src/ui/grid.js` STYLE_TEXT), `.gp-pr-label` 10 px (`src/ui/pianoroll.js`), `.gp-tab` and help table 12 px off-grid (`styles/app.css:39,140`). Consistent with the dense-hardware register but technically drift from the stated scale.

### F10 - INFO - Beat/bar rules are per-row segments, not one continuous column rule

Documented tradeoff at `styles/grid.css:266-271` (flat cell DOM has no free pseudo-element to span rows). Grouping still reads; note only, no action required.

---

## PASS list (checklist items verified)

1. **Tokens**: all 13 role tokens x 3 themes and all 8 track palette slots x 3 themes match DESIGN.md exactly (`styles/tokens.css`).
2. **Step-state composition**: pseudo-element budget respected (::before hatch, ::after accent bar, conic nudge layer, ratchet strips on background-image do not collide); `[data-lowprob]` restores dashed border over filled cells; `.is-selected` declared after `.is-playing` and wins; bar-start beats beat-start when both classes present. One collision found: F1.
3. **Cell size**: 28 px desktop / 40 px under `pointer: coarse` (`tokens.css:114-115`, `grid.css:70-85`); >= 24 px requirement met.
4. **Focus**: global `:focus-visible` uses `--focus-ring` everywhere interactive (base.css; explicit on fader); roving tabindex present (`grid.js:228-246`; DOM shows single `tabindex="0"` cell). Caveat F5.
5. **SR semantics**: `role=grid > row > rowheader/gridcell` confirmed in DOM; per-state aria-labels include velocity/probability/ratchet/nudge ms (`grid.js:196-216`); `announce()` writes `#live-region` (`aria-live="polite"`, index.html:32; main.js:97; wired into grid/soundbay/pianoroll).
6. **Reduced motion**: `.gp-playhead` hidden under PRM (`grid.css:309-313`); `setPlayheadBeat` branches on `matchMedia('prefers-reduced-motion: reduce')` to the discrete column highlight (`grid.js:645-652`); base.css kills animations/transitions except opacity; cells have no transition/animation at all.
7. **Contrast**: all text pairs pass AA (see table under F2); failures flagged in F2/F6.
8. **Motion rules**: no `@keyframes` anywhere in `styles/`; sole easing `cubic-bezier(0.22,1,0.36,1)` has no overshoot (no bounce on toggles); control feedback 120 ms ease-out; playhead moved via transform translateX only. Exception: F7 (toast 180 ms vs 150 ms).
9. **Banned list**: no purple-blue gradients (gradients confined to fg hatch/ticks, knob accent arc, meter ok-to-danger fill); no glassmorphism/backdrop-filter (grep clean); no emoji/icon glyphs in JS-rendered strings (unicode sweep of `src/**/*.js` clean; transport icons are inline SVG paths); box-shadow used only for structural beat/bar stripes and knob inset rings - no drop shadows on cells; no textures; no neon glow (no text-shadow anywhere); meters are real: meter loop reads `ch.meter()` per track every 66 ms (~15 fps <= 30 fps cap, `main.js:453-474`) into RMS+peak CSS props.
10. **Required states**: empty project seeds starter pattern + hint line (DOM shows 24 active steps, hint rendered); audio-blocked reachable and styled (`status-bar.is-audio-blocked` + CLICK TO START AUDIO button confirmed in DOM; caveat F3); toast error styling via `[data-kind="error"]` danger edge (`components.css:394`); sample decode failure toasts name file + reason and keep previous buffer (`samplelib.js:18-24`, `main.js:564-567, 788-790`); no-MIDI inline mono message in settings (`#s-midi-status`, main.js:745-747, 853-889). Exception: loading overlay unreachable (F4).

Not committed. No files modified other than this report.
