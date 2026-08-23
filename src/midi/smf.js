export const PPQ = 480;

export function vlq(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0x0fffffff) {
    throw new RangeError(`vlq: value out of range 0..0x0fffffff (${n})`);
  }
  const bytes = [n & 0x7f];
  n >>>= 7;
  while (n > 0) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  return bytes.reverse();
}

const NOTE_TYPES = { noteOff: 0x80, noteOn: 0x90 };

function intRange(v, lo, hi, name) {
  if (!Number.isInteger(v)) throw new TypeError(`${name}: integer required`);
  if (v < lo || v > hi) throw new RangeError(`${name}: out of range ${lo}..${hi}`);
}

export function writePatternSMF(spec) {
  if (spec == null || typeof spec !== 'object') {
    throw new TypeError('writePatternSMF: spec object required');
  }
  const { tempoBpm, tracks } = spec;
  if (typeof tempoBpm !== 'number' || !Number.isFinite(tempoBpm) || tempoBpm <= 0) {
    throw new TypeError('writePatternSMF: tempoBpm must be a positive number');
  }
  const tempoUs = Math.round(60000000 / tempoBpm);
  if (tempoUs > 0xffffff) throw new RangeError('writePatternSMF: tempo too slow for meta event');
  if (!Array.isArray(tracks)) throw new TypeError('writePatternSMF: tracks array required');

  const flat = [];
  for (let ti = 0; ti < tracks.length; ti++) {
    const tr = tracks[ti];
    if (tr == null || typeof tr !== 'object') throw new TypeError(`tracks[${ti}]: object required`);
    intRange(tr.channel, 0, 15, `tracks[${ti}].channel`);
    if (!Array.isArray(tr.events)) throw new TypeError(`tracks[${ti}].events: array required`);
    for (let ei = 0; ei < tr.events.length; ei++) {
      const e = tr.events[ei];
      if (e == null || typeof e !== 'object') {
        throw new TypeError(`tracks[${ti}].events[${ei}]: object required`);
      }
      intRange(e.tick, 0, 0x0fffffff, `tracks[${ti}].events[${ei}].tick`);
      if (!(e.type in NOTE_TYPES)) {
        throw new TypeError(`tracks[${ti}].events[${ei}].type: 'noteOn' or 'noteOff' required`);
      }
      intRange(e.note, 0, 127, `tracks[${ti}].events[${ei}].note`);
      intRange(e.velocity, 0, 127, `tracks[${ti}].events[${ei}].velocity`);
      flat.push({
        tick: e.tick,
        ti,
        status: NOTE_TYPES[e.type] | tr.channel,
        note: e.note,
        velocity: e.velocity
      });
    }
  }

  flat.sort(
    (a, b) => a.tick - b.tick || a.ti - b.ti || (a.status & 0xf0) - (b.status & 0xf0)
  );

  const data = [
    0x00, 0xff, 0x51, 0x03,
    (tempoUs >> 16) & 0xff, (tempoUs >> 8) & 0xff, tempoUs & 0xff
  ];
  let prev = 0;
  for (const ev of flat) {
    for (const b of vlq(ev.tick - prev)) data.push(b);
    prev = ev.tick;
    data.push(ev.status, ev.note, ev.velocity);
  }
  data.push(0x00, 0xff, 0x2f, 0x00);

  const head = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x00, 0x00, 0x01,
    (PPQ >> 8) & 0xff, PPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    (data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff, data.length & 0xff
  ];
  const out = new Uint8Array(head.length + data.length);
  out.set(head, 0);
  out.set(data, head.length);
  return out;
}

export function parseSMF(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const u32 = (o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const u16 = (o) => (u8[o] << 8) | u8[o + 1];

  if (u8.length < 14 || String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'MThd') {
    throw new Error('parseSMF: missing MThd header');
  }
  const headLen = u32(4);
  const format = u16(8);
  const ntrks = u16(10);
  const division = u16(12);

  const tracks = [];
  let o = 8 + headLen;
  while (o + 8 <= u8.length) {
    const id = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    const len = u32(o + 4);
    const start = o + 8;
    const end = Math.min(start + len, u8.length);
    if (id === 'MTrk') tracks.push(readTrack(u8, start, end));
    o = start + len;
  }
  return { format, ntrks, division, tracks };
}

function readTrack(u8, start, end) {
  let o = start;
  let tick = 0;
  let status = 0;
  let tempoUs;
  const events = [];
  const readVlq = () => {
    let v = 0;
    for (;;) {
      const c = u8[o++];
      v = (v << 7) | (c & 0x7f);
      if ((c & 0x80) === 0) break;
    }
    return v >>> 0;
  };
  while (o < end) {
    tick += readVlq();
    const b = u8[o];
    if (b === 0xff) {
      o += 1;
      const type = u8[o++];
      const len = readVlq();
      if (type === 0x51 && len === 3) {
        tempoUs = (u8[o] << 16) | (u8[o + 1] << 8) | u8[o + 2];
      } else if (type === 0x2f) {
        break;
      }
      o += len;
    } else if (b === 0xf0 || b === 0xf7) {
      o += 1;
      o += readVlq();
    } else {
      if ((b & 0x80) !== 0) {
        status = b;
        o += 1;
      }
      const hi = status & 0xf0;
      const d1 = u8[o++];
      if (hi === 0xc0 || hi === 0xd0) {
        events.push({ tick, status, note: d1 });
      } else {
        events.push({ tick, status, note: d1, velocity: u8[o++] });
      }
    }
  }
  return { events, tempoUs };
}
