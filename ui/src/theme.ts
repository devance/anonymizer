import { useSyncExternalStore } from 'react';

/**
 * Light (Devance rust on slate) or dark (royal blue). Follows the system until
 * someone flips the switch; the choice is kept in this browser.
 */

export type Theme = 'light' | 'dark';
const STORAGE = 'anon:theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

let chosen: Theme | null = stored();
const listeners = new Set<() => void>();

function apply() {
  if (chosen) document.documentElement.dataset.theme = chosen;
  else delete document.documentElement.dataset.theme;
}
apply();
media.addEventListener('change', () => listeners.forEach((l) => l()));

export function currentTheme(): Theme {
  return chosen ?? (media.matches ? 'dark' : 'light');
}

export function toggleTheme() {
  chosen = currentTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(STORAGE, chosen);
  } catch {
    /* private mode */
  }
  apply();
  listeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    currentTheme,
  );
}
