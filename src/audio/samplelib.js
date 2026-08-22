export const MAX_SAMPLE_BYTES = 20971520;

function decodeCompat(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let promise;
    try {
      promise = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    } catch (err) {
      reject(err);
      return;
    }
    if (promise && typeof promise.then === 'function') {
      promise.then(resolve, reject);
    }
  });
}

function decodeFailure(name, err) {
  const reason =
    err instanceof Error && typeof err.message === 'string' && err.message.trim()
      ? err.message
      : 'not valid audio';
  return new Error(`cannot decode ${name}: ${reason}`);
}

export async function loadSampleFile(file, ctx) {
  const name = file && file.name ? String(file.name) : 'sample';
  if (file.size > MAX_SAMPLE_BYTES) {
    throw new Error(`file too large (>20 MB): ${name}`);
  }

  let arrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch (err) {
    throw decodeFailure(name, err);
  }

  let decoded;
  try {
    decoded = await decodeCompat(ctx, arrayBuffer);
  } catch (err) {
    throw decodeFailure(name, err);
  }

  if (
    !decoded ||
    typeof decoded !== 'object' ||
    typeof decoded.numberOfChannels !== 'number' ||
    typeof decoded.length !== 'number'
  ) {
    throw decodeFailure(name, null);
  }
  if (decoded.numberOfChannels < 1) {
    throw new Error(`cannot decode ${name}: no audio channels`);
  }
  if (decoded.length < 1) {
    throw new Error(`cannot decode ${name}: empty sample`);
  }

  return { buffer: decoded, name };
}

export function audioBufferToMonoSummary(buffer) {
  if (!buffer || typeof buffer !== 'object') {
    return { durationSec: 0, sampleRate: 0, channels: 0 };
  }
  return {
    durationSec:
      typeof buffer.duration === 'number' && Number.isFinite(buffer.duration)
        ? buffer.duration
        : 0,
    sampleRate:
      typeof buffer.sampleRate === 'number' && Number.isFinite(buffer.sampleRate)
        ? buffer.sampleRate
        : 0,
    channels:
      typeof buffer.numberOfChannels === 'number' &&
      Number.isFinite(buffer.numberOfChannels)
        ? buffer.numberOfChannels
        : 0
  };
}
