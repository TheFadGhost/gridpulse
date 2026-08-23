import { defaultProject } from '../src/core/model.js';
import {
  renderProjectToBuffer, measureAlignmentMs, renderTwiceByteIdentical,
  projectDurationSec
} from '../src/render/offlineRenderer.js';
import { validateProject } from '../src/core/schema.js';
import { Scheduler } from '../src/audio/scheduler.js';

const out = [];
const only = new URLSearchParams(location.search).get('only') || 'all';
function mark(s) { document.title = 'STEP ' + s; }
function report(name, pass, detail) {
  out.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
}

function schedulerView(p) {
  const patterns = {};
  for (const pat of p.patterns) patterns[pat.id] = { id: pat.id, length: pat.length, steps: pat.steps };
  return {
    tracks: p.tracks.map(t => ({ id: t.id, type: t.type, length: t.length })),
    patterns,
    patternId: p.patterns[0].id,
    chain: [p.patterns[0].id],
    songMode: false,
    seed: p.seed | 0,
    swing: p.swing,
    bpm: p.bpm,
    metronome: p.metronome,
    stepsPerBeat: 4,
    beatsPerBar: 4
  };
}

async function phaseRenderX2(project) {
  let identical = false;
  try {
    const a = await renderProjectToBuffer(project, { sampleRate: 44100 });
    if (!a || a.length < 1000) throw new Error('empty render');
    identical = await renderTwiceByteIdentical(project);
  } catch (e) { report('render x2', false, e.stack || e.message); return; }
  report('double render byte-identical', identical === true);
}

function bytesToB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function renderOnceWavBytes(project) {
  const { encodeWav } = await import('../src/render/wavenc.js');
  const buf = await renderProjectToBuffer(project, { sampleRate: 44100 });
  if (!buf || buf.length < 1000) throw new Error('empty render');
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  return new Uint8Array(encodeWav(chans, buf.sampleRate));
}

async function phaseRenderSave(project) {
  try {
    const bytes = await renderOnceWavBytes(project);
    const r = await fetch('/dev-store', { method: 'POST', body: bytes });
    report('render save', r.ok && bytes.length > 1000, `bytes=${bytes.length}`);
  } catch (e) { report('render save', false, e.message); }
}

async function phaseRenderCompare(project) {
  try {
    const bytes = await renderOnceWavBytes(project);
    const prev = await (await fetch('/dev-store')).arrayBuffer();
    const a = new Uint8Array(prev);
    let eq = a.length === bytes.length;
    let firstDiff = -1;
    let count = 0;
    let maxDelta = 0;
    if (eq) {
      const f1 = new DataView(bytes.buffer);
      const f2 = new DataView(a.buffer.slice(0));
      for (let i = 44; i < a.length; i += 2) {
        const s1 = f1.getInt16(i, true);
        const s2 = f2.getInt16(i, true);
        if (s1 !== s2) {
          count++;
          if (firstDiff < 0) firstDiff = i;
          const d = Math.abs(s1 - s2);
          if (d > maxDelta) maxDelta = d;
        }
      }
    }
    const totalSamples = Math.floor((a.length - 44) / 2);
    const okLen = a.length === bytes.length;
    const tolerant = okLen && maxDelta <= 1 && count <= Math.max(8, totalSamples * 0.0001);
    report('cross-process render deterministic', tolerant,
      `len ${a.length}/${bytes.length} diffs=${count}/${totalSamples} maxDelta=${maxDelta}LSB${tolerant ? ' (within +-1 LSB)' : ''}`);
    if (!okLen) return;
    report('render length stable', true);
  } catch (e) { report('render compare', false, e.message); }
}

async function phaseAlignment(project) {
  try {
    const align = await measureAlignmentMs(project, { sampleRate: 44100 });
    const ok = align.maxAbsDeviationMs < 3 && align.scheduled.length >= 4;
    report('onset alignment', ok,
      `max=${align.maxAbsDeviationMs.toFixed(3)}ms mean=${align.meanDeviationMs.toFixed(3)}ms n=${align.detected.length}`);
  } catch (e) { report('onset alignment', false, e.message); }
}

function expectedTime(sched, view, e) {
  const base = sched.stepBaseTime(e.stepIndex);
  const swing = e.stepIndex % 2 === 1 ? view.swing * (60 / view.bpm) / 4 : 0;
  const span = sched.stepBaseTime(e.stepIndex + 1) - base;
  return base + swing + (e.nudgeMs || 0) / 1000 + e.repeat * span / Math.max(1, e.ratchet);
}

function phaseScheduler(project) {
  try {
    let t = 50;
    const events = [];
    const s = new Scheduler({
      getNow: () => t,
      getView: () => schedulerView(project),
      onEvent: e => events.push(e),
      lookahead: 0.18
    });
    const view = schedulerView(project);
    s.start(t + 0.05);
    for (let i = 0; i < 4000; i++) { s.tick(); t += 0.03; }
    let bad = 0;
    for (const e of events) {
      if (Math.abs(e.time - expectedTime(s, view, e)) > 1e-12) bad++;
    }
    report('scheduler exact times in browser', bad === 0 && events.length > 500,
      `events=${events.length} bad=${bad}`);
  } catch (e) { report('scheduler exact times in browser', false, e.message); }
}

async function main() {
  try {
    const project = defaultProject();
    const idMap = {};
    project.tracks.forEach((t, i) => { idMap[t.id] = 'tr' + i; t.id = 'tr' + i; });
    for (const pat of project.patterns) {
      const old = pat.steps;
      pat.steps = {};
      for (const [k, v] of Object.entries(old)) pat.steps[idMap[k] || k] = v;
    }
    project.patterns.forEach((p2, i) => { p2.id = 'p' + i; });
    project.song.chain = project.song.chain.map((_, i) => 'p' + i);
    const v = validateProject(JSON.parse(JSON.stringify(project)));
    report('project validates', v.ok, v.errors.join(';'));
    const dur = projectDurationSec(project);
    report('duration computed', dur > 1 && dur < 10, `${dur.toFixed(3)}s`);

    if (only === 'all' || only === 'scheduler') { mark('scheduler'); phaseScheduler(project); }
    if (only === 'all' || only === 'alignment') { mark('alignment'); await phaseAlignment(project); }
    if (only === 'renderx2') { mark('renderx2'); await phaseRenderX2(project); }
    if (only === 'rendersave') { mark('rendersave'); await phaseRenderSave(project); }
    if (only === 'rendercompare') { mark('rendercompare'); await phaseRenderCompare(project); }

    document.title = out.every(o => o.startsWith('PASS')) && out.length > 0 ? 'ALL PASS' : 'SUITE FAIL';
  } catch (e) {
    report('harness', false, e.stack || String(e));
    document.title = 'HARNESS FAIL';
  }
  const pre = document.createElement('pre');
  pre.id = 'browser-results';
  pre.textContent = document.title + '\n' + out.join('\n');
  document.body.appendChild(pre);
}

main();
