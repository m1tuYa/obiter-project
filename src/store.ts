import type { State } from './types';

const KEY = 'orbiter.state.v1';

export function loadState(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.grains) || !Array.isArray(parsed.themes)) return emptyState();
    return {
      grains: parsed.grains,
      themes: parsed.themes,
      ecoSeconds: typeof parsed.ecoSeconds === 'number' ? parsed.ecoSeconds : 0,
    };
  } catch {
    return emptyState();
  }
}

export function saveState(state: State): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function emptyState(): State {
  return { grains: [], themes: [], ecoSeconds: 0 };
}

export function exportJson(state: State): void {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  a.href = url;
  a.download = `orbiter-export-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseImportedJson(text: string): State | null {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.grains) || !Array.isArray(parsed.themes)) return null;
    return {
      grains: parsed.grains,
      themes: parsed.themes,
      ecoSeconds: typeof parsed.ecoSeconds === 'number' ? parsed.ecoSeconds : 0,
    };
  } catch {
    return null;
  }
}
