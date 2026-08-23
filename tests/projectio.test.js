import { test } from 'node:test';
import assert from 'node:assert/strict';

class LocalStorageStub {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(String(k)) ? this.map.get(String(k)) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new LocalStorageStub();

const {
  SLOT_PREFIX, sanitizeSlotName, listLocalSlots, saveToLocalSlot,
  loadFromLocalSlot, deleteLocalSlot, readProjectFile,
  embedSamples, extractEmbeddedSamples
} = await import('../src/io/projectio.js');
const { encodeWav } = await import('../src/render/wavenc.js');
const { defaultProject } = await import('../src/core/model.js');

test('sanitizeSlotName trims, collapses whitespace, keeps inner spaces', () => {
  assert.equal(sanitizeSlotName('  spaced   out  '), 'spaced out');
  assert.equal(sanitizeSlotName('tab\tname'), 'tab name');
  assert.equal(sanitizeSlotName('\n lead \r mid \n'), 'lead mid');
});

test('sanitizeSlotName strips path-hostile and control chars', () => {
  assert.equal(sanitizeSlotName('../../etc/passwd'), '....etcpasswd');
  assert.equal(sanitizeSlotName('C:\\temp\\file:name*'), 'Ctempfilename');
  assert.equal(sanitizeSlotName('a<b>c:d"e|f?g*h'), 'abcdefgh');
  assert.equal(sanitizeSlotName('bell\u0007x\u001f\u007f'), 'bellx');
});

test('sanitizeSlotName caps at 60 chars and falls back to untitled', () => {
  assert.equal(sanitizeSlotName('x'.repeat(100)), 'x'.repeat(60));
  assert.equal(sanitizeSlotName('y'.repeat(60)) + 'z', 'y'.repeat(60) + 'z');
  for (const bad of ['', '   ', '///', ':*?"<>|', null, undefined]) {
    assert.equal(sanitizeSlotName(bad), 'untitled');
  }
});

test('save/load round-trip preserves project field-for-field', () => {
  const p = defaultProject();
  saveToLocalSlot('My Slot!', p);
  const rec = loadFromLocalSlot('My Slot!');
  assert.equal(typeof rec.savedAt, 'number');
  assert.ok(rec.savedAt > 0);
  assert.deepEqual(rec.project, p);
  assert.equal(rec.project.patterns[0].steps[p.tracks[6].id][0].vel,
               p.patterns[0].steps[p.tracks[6].id][0].vel);
  assert.ok(globalThis.localStorage.getItem(SLOT_PREFIX + 'My Slot!'));
});

test('listLocalSlots returns newest first by savedAt', () => {
  const realNow = Date.now;
  let tick = 1_000_000;
  try {
    Date.now = () => ++tick;
    saveToLocalSlot('older one', defaultProject());
    tick += 5000;
    saveToLocalSlot('newer one', defaultProject());
  } finally {
    Date.now = realNow;
  }
  const names = listLocalSlots().map(s => s.name);
  assert.ok(names.includes('older one') && names.includes('newer one'));
  assert.ok(names.indexOf('newer one') < names.indexOf('older one'));
  const slots = listLocalSlots().filter(s => s.name === 'newer one');
  assert.equal(slots.length, 1);
  assert.equal(typeof slots[0].savedAt, 'number');
});

test('deleteLocalSlot removes the slot; deleting missing is a no-op', () => {
  saveToLocalSlot('doomed', defaultProject());
  assert.ok(globalThis.localStorage.getItem(SLOT_PREFIX + 'doomed'));
  deleteLocalSlot('doomed');
  assert.equal(globalThis.localStorage.getItem(SLOT_PREFIX + 'doomed'), null);
  deleteLocalSlot('never-existed');
  assert.equal(listLocalSlots().findIndex(s => s.name === 'doomed'), -1);
});

test('loadFromLocalSlot throws friendly error on missing slot', () => {
  assert.throws(() => loadFromLocalSlot('missing slot xyz'), /slot not found/);
});

test('corrupted JSON in a slot raises a listing Error, list skips it', () => {
  globalThis.localStorage.setItem(SLOT_PREFIX + 'broken', '{oops not json');
  assert.throws(() => loadFromLocalSlot('broken'), /not valid JSON/);
  assert.doesNotThrow(() => listLocalSlots());
});

test('schema-invalid stored project raises invalid-project error listing problems', () => {
  const bad = defaultProject();
  bad.bpm = 9999;
  globalThis.localStorage.setItem(
    SLOT_PREFIX + 'badval',
    JSON.stringify({ savedAt: 42, project: bad })
  );
  try {
    loadFromLocalSlot('badval');
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /^invalid project: /);
    assert.match(e.message, /bpm: out of range 20\.\.333/);
  }
});

test('saveToLocalSlot maps quota errors to "storage full"', () => {
  class FullStorage {
    get length() { return 0; }
    key() { return null; }
    getItem() { return null; }
    setItem() { const e = new Error('quota exceeded'); e.name = 'QuotaExceededError'; throw e; }
    removeItem() {}
    clear() {}
  }
  const real = globalThis.localStorage;
  globalThis.localStorage = new FullStorage();
  try {
    assert.throws(() => saveToLocalSlot('nope', defaultProject()), /^Error: storage full$/);
  } finally {
    globalThis.localStorage = real;
  }
});

const hasBlob = typeof Blob !== 'undefined';

if (hasBlob) test('readProjectFile parses valid JSON file into validated project', async () => {
  const p = defaultProject();
  const got = await readProjectFile(new Blob([JSON.stringify(p)], { type: 'application/json' }));
  assert.deepEqual(got, p);
});

if (hasBlob) test('readProjectFile maps parse failure to friendly error', async () => {
  await assert.rejects(
    () => readProjectFile(new Blob(['{oops not json'])),
    /^Error: not valid JSON$/
  );
  await assert.rejects(() => readProjectFile(new Blob([''])), /not valid JSON/);
});

if (hasBlob) test('readProjectFile validates schema and lists problems on failure', async () => {
  await assert.rejects(
    () => readProjectFile(new Blob([JSON.stringify({ foo: 1 })])),
    e => { assert.match(e.message, /^invalid project: /); return true; }
  );
  const bad = defaultProject();
  bad.swing = 5;
  await assert.rejects(
    () => readProjectFile(new Blob([JSON.stringify(bad)])),
    e => { assert.match(e.message, /swing: out of range 0\.\.0\.6/); return true; }
  );
});

function fakeBuffer(channels, sampleRate) {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0].length,
    getChannelData: i => channels[i]
  };
}

test('encodeWav produces RIFF/WAVE bytes from tiny synthetic buffer', () => {
  const chans = [Float32Array.of(0.1, -0.1)];
  const wav = encodeWav(chans, 8000, 16);
  assert.ok(wav instanceof ArrayBuffer);
  assert.equal(wav.byteLength, 44 + 2 * 2);
  const b = new Uint8Array(wav);
  assert.equal(b[0], 0x52); assert.equal(b[1], 0x49); // 'RI'
  assert.equal(b[2], 0x46); assert.equal(b[3], 0x46); // 'FF'
  assert.equal(b[8], 0x57); assert.equal(b[9], 0x41); // 'WA'
  assert.equal(b[10], 0x56); assert.equal(b[11], 0x45); // 'VE'
});

test('embedSamples clones, embeds base64 WAV only on mapped sampler tracks', async () => {
  const p = defaultProject();
  const sampler = p.tracks.find(t => t.type === 'sampler');
  const synth = p.tracks.find(t => t.type === 'synth');
  const chans = [Float32Array.of(0.1, -0.1)];
  const buffersMap = new Map([
    [sampler.id, { buffer: fakeBuffer(chans, 8000), name: 'tone.wav' }]
  ]);

  const embedded = await embedSamples(p, buffersMap);
  assert.notEqual(embedded, p);

  const es = embedded.tracks.find(t => t.id === sampler.id);
  const orig = p.tracks.find(t => t.id === sampler.id);
  assert.ok(!orig.sampleData, 'original project untouched');
  assert.equal(es.sampleData.name, 'tone.wav');
  assert.equal(es.sampleData.sampleRate, 8000);

  const direct = new Uint8Array(encodeWav(chans, 8000, 16));
  const bytes = Uint8Array.from(atob(es.sampleData.base64), ch => ch.charCodeAt(0));
  assert.deepEqual([...bytes], [...direct]);
});

test('embedSamples leaves unmapped tracks and projects without map untouched', async () => {
  const p = defaultProject();
  const noEmbed = await embedSamples(p, new Map());
  assert.deepEqual(noEmbed, p);
  const noMap = await embedSamples(p);
  assert.deepEqual(noMap, p);
});

test('extractEmbeddedSamples round-trips embedded data back out', async () => {
  const p = defaultProject();
  const sampler = p.tracks.find(t => t.type === 'sampler');
  const chans = [Float32Array.of(0.1, -0.1)];
  const embedded = await embedSamples(p, new Map([
    [sampler.id, { buffer: fakeBuffer(chans, 8000), name: 'tone.wav' }]
  ]));

  const extracted = extractEmbeddedSamples(embedded);
  assert.equal(extracted.size, 1);
  const entry = extracted.get(sampler.id);
  assert.deepEqual(entry, {
    name: 'tone.wav',
    sampleRate: 8000,
    base64: embedded.tracks.find(t => t.id === sampler.id).sampleData.base64
  });

  const fresh = extractEmbeddedSamples(defaultProject());
  assert.equal(fresh.size, 0);
  const none = extractEmbeddedSamples(null);
  assert.equal(none.size, 0);
});
