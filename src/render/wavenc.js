const HEADER_BYTES = 44;
const PCM_FORMAT = 1;

function writeStr(dv, off, str) {
  for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i));
}

export function encodeWav(channels, sampleRate, bitDepth = 16) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error('wavenc: channels must be a non-empty array');
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error('wavenc: sampleRate must be a positive integer');
  }
  if (bitDepth !== 16) {
    throw new Error('wavenc: unsupported bitDepth (only 16-bit PCM)');
  }
  const numCh = channels.length;
  const frames = channels[0].length;
  for (const ch of channels) {
    if (!(ch instanceof Float32Array)) throw new Error('wavenc: each channel must be a Float32Array');
    if (ch.length !== frames) throw new Error('wavenc: channel length mismatch');
  }

  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLen = frames * blockAlign;

  const buffer = new ArrayBuffer(HEADER_BYTES + dataLen);
  const dv = new DataView(buffer);

  writeStr(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  writeStr(dv, 8, 'WAVE');
  writeStr(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, PCM_FORMAT, true);
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitDepth, true);
  writeStr(dv, 36, 'data');
  dv.setUint32(40, dataLen, true);

  let o = HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];
      if (Number.isNaN(s)) s = 0;
      else if (s > 1) s = 1;
      else if (s < -1) s = -1;
      let v = Math.round(s * 32767);
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      dv.setInt16(o, v, true);
      o += bytesPerSample;
    }
  }
  return buffer;
}
