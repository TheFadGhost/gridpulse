import { validateProject } from '../core/schema.js';
import { encodeWav } from '../render/wavenc.js';

export const SLOT_PREFIX = 'gridpulse.project.';

const MAX_NAME_LEN = 60;
const B64_CHUNK = 0x8000;

function ls() {
  const store = globalThis.localStorage;
  if (!store) throw new Error('localStorage unavailable');
  return store;
}

function slotKey(name) {
  return SLOT_PREFIX + sanitizeSlotName(name);
}

function isQuotaError(e) {
  if (!e) return false;
  if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  if (typeof e.code === 'number' && (e.code === 22 || e.code === 1014)) return true;
  return false;
}

export function sanitizeSlotName(name) {
  let s = String(name == null ? '' : name);
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '');
  s = s.trim().slice(0, MAX_NAME_LEN).trim();
  return s || 'untitled';
}

export function listLocalSlots() {
  const store = ls();
  const out = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || !key.startsWith(SLOT_PREFIX)) continue;
    let rec = null;
    try { rec = JSON.parse(store.getItem(key)); } catch (_) { continue; }
    out.push({
      name: key.slice(SLOT_PREFIX.length),
      savedAt: rec && typeof rec.savedAt === 'number' ? rec.savedAt : 0
    });
  }
  out.sort((a, b) => (b.savedAt - a.savedAt) || a.name.localeCompare(b.name));
  return out;
}

export function saveToLocalSlot(name, project) {
  const payload = JSON.stringify({ savedAt: Date.now(), project });
  try {
    ls().setItem(slotKey(name), payload);
  } catch (e) {
    if (isQuotaError(e)) throw new Error('storage full');
    throw e;
  }
}

export function loadFromLocalSlot(name) {
  const sane = sanitizeSlotName(name);
  const raw = ls().getItem(slotKey(sane));
  if (raw == null) throw new Error(`slot not found: ${sane}`);
  let rec;
  try { rec = JSON.parse(raw); } catch (_) { throw new Error(`corrupt slot "${sane}": not valid JSON`); }
  const v = validateProject(rec && rec.project);
  if (!v.ok) throw new Error('invalid project: ' + v.errors.join('; '));
  return { project: v.project, savedAt: typeof rec.savedAt === 'number' ? rec.savedAt : 0 };
}

export function deleteLocalSlot(name) {
  ls().removeItem(slotKey(name));
}

export function downloadProjectJSON(project) {
  const fname = `gridpulse-${sanitizeSlotName((project && project.name) || '')}.json`;
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function readProjectFile(file) {
  let text = '';
  try { text = await file.text(); }
  catch (_) { throw new Error('could not read file'); }
  let obj;
  try { obj = JSON.parse(text); }
  catch (_) { throw new Error('not valid JSON'); }
  const v = validateProject(obj);
  if (!v.ok) throw new Error('invalid project: ' + v.errors.join('; '));
  return v.project;
}

function bytesToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(bin);
}

export async function embedSamples(project, buffersMap) {
  const clone = JSON.parse(JSON.stringify(project));
  const map = buffersMap instanceof Map ? buffersMap : null;
  if (!map || !Array.isArray(clone.tracks)) return clone;
  for (const t of clone.tracks) {
    if (!t || t.type !== 'sampler') continue;
    const entry = map.get(t.id);
    if (!entry || !entry.buffer) continue;
    const buf = entry.buffer;
    const channels = [];
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
    const wavBytes = encodeWav(channels, buf.sampleRate, 16);
    t.sampleData = {
      name: entry.name != null ? String(entry.name) : (t.name || 'sample'),
      sampleRate: buf.sampleRate,
      base64: bytesToBase64(wavBytes)
    };
  }
  return clone;
}

export function extractEmbeddedSamples(project) {
  const out = new Map();
  if (!project || !Array.isArray(project.tracks)) return out;
  for (const t of project.tracks) {
    if (t && t.type === 'sampler' && t.id && t.sampleData &&
        typeof t.sampleData.base64 === 'string') {
      out.set(t.id, {
        name: t.sampleData.name,
        sampleRate: t.sampleData.sampleRate,
        base64: t.sampleData.base64
      });
    }
  }
  return out;
}
