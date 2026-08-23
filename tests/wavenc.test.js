import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from '../src/render/wavenc.js';

function dvOf(ab) { return new DataView(ab); }
function ascii(dv, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
  return s;
}

test('header magic fields', () => {
  const ab = encodeWav([new Float32Array([0])], 44100);
  const dv = dvOf(ab);
  assert.equal(ab.byteLength, 46);
  assert.equal(ascii(dv, 0, 4), 'RIFF');
  assert.equal(dv.getUint32(4, true), 38);
  assert.equal(ascii(dv, 8, 4), 'WAVE');
  assert.equal(ascii(dv, 12, 4), 'fmt ');
  assert.equal(dv.getUint32(16, true), 16);
  assert.equal(dv.getUint16(20, true), 1);
  assert.equal(dv.getUint16(22, true), 1);
  assert.equal(dv.getUint32(24, true), 44100);
  assert.equal(dv.getUint32(28, true), 44100 * 2);
  assert.equal(dv.getUint16(32, true), 2);
  assert.equal(dv.getUint16(34, true), 16);
  assert.equal(ascii(dv, 36, 4), 'data');
  assert.equal(dv.getUint32(40, true), 2);
});

test('stereo data chunk length = frames*channels*2 and header math follows', () => {
  const ab = encodeWav([new Float32Array(100), new Float32Array(100)], 48000);
  const dv = dvOf(ab);
  assert.equal(dv.getUint32(40, true), 400);
  assert.equal(ab.byteLength, 444);
  assert.equal(dv.getUint32(4, true), 436);
  assert.equal(dv.getUint16(22, true), 2);
  assert.equal(dv.getUint32(28, true), 48000 * 4);
  assert.equal(dv.getUint16(32, true), 4);
});

test('DC 0.5 buffer encodes to expected int16 little-endian bytes', () => {
  const mono = new Float32Array(4).fill(0.5);
  const ab = encodeWav([mono], 44100);
  const dv = dvOf(ab);
  for (let i = 0; i < 4; i++) {
    assert.equal(dv.getInt16(44 + i * 2, true), 16384);
  }
  const b = new Uint8Array(ab);
  assert.deepEqual([b[44], b[45]], [0x00, 0x40]);
});

test('channels interleave frame-by-frame in file order', () => {
  const ab = encodeWav([new Float32Array(2).fill(0.5), new Float32Array(2).fill(-0.5)], 44100);
  const dv = dvOf(ab);
  assert.equal(dv.getInt16(44, true), 16384);
  assert.equal(dv.getInt16(46, true), -16383);
  assert.equal(dv.getInt16(48, true), 16384);
  assert.equal(dv.getInt16(50, true), -16383);
});

test('clamping: 1.5 -> 32767, out-of-range lows clamp too', () => {
  const ab = encodeWav([new Float32Array([1.5, -1.5, 2, -0.75, 0])], 8000);
  const dv = dvOf(ab);
  assert.equal(dv.getInt16(44 + 0 * 2, true), 32767);
  assert.equal(dv.getInt16(44 + 1 * 2, true), -32767);
  assert.equal(dv.getInt16(44 + 2 * 2, true), 32767);
  assert.equal(dv.getInt16(44 + 3 * 2, true), Math.round(-0.75 * 32767));
  assert.equal(dv.getInt16(44 + 4 * 2, true), 0);
});

test('determinism: identical inputs produce byte-identical output', () => {
  const mk = () => Float32Array.from({ length: 256 }, (_, i) => Math.sin(i * 0.1) * 0.9);
  const a = new Uint8Array(encodeWav([mk(), mk()], 44100));
  const b = new Uint8Array(encodeWav([mk(), mk()], 44100));
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], `byte ${i} differs`);
});

test('rejects bad inputs deterministically', () => {
  assert.throws(() => encodeWav([], 44100), /non-empty/);
  assert.throws(() => encodeWav([new Float32Array(2)], 44100, 24), /bitDepth/);
  assert.throws(() => encodeWav([new Float32Array(2), new Float32Array(3)], 44100), /mismatch/);
  assert.throws(() => encodeWav([new Float32Array(2)], 0), /sampleRate/);
});
