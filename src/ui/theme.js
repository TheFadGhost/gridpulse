export const THEMES = ['dark', 'light', 'contrast'];

const STORAGE_KEY = 'gridpulse.theme';

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function persist(name) {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Storage unavailable (private mode / sandbox): theme stays session-only.
  }
}

export function applyTheme(name) {
  const next = THEMES.includes(name) ? name : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  persist(next);
  return next;
}

export function currentTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  return THEMES.includes(attr) ? attr : 'dark';
}

export function initTheme() {
  const stored = readStored();
  let name = stored !== null && THEMES.includes(stored) ? stored : null;
  if (name === null) {
    const query = window.matchMedia('(prefers-contrast: more)');
    if (query.matches) name = 'contrast';
  }
  return applyTheme(name === null ? 'dark' : name);
}
