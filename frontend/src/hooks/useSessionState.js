import { useState, useEffect } from 'react';

// useState that persists to sessionStorage under `key` (per browser tab/window).
// `initial` may be a value or a factory. Bump VERSION to invalidate old shapes.
const VERSION = 'v2';
export function useSessionState(key, initial) {
  const storageKey = `roms:${key}:${VERSION}`;
  const [value, setValue] = useState(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw != null) return JSON.parse(raw);
    } catch { /* ignore */ }
    return typeof initial === 'function' ? initial() : initial;
  });
  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* ignore */ }
  }, [storageKey, value]);
  return [value, setValue];
}

// True if the key was already stored this session (for gating first-visit seeding).
export function hasSessionState(key) {
  try { return sessionStorage.getItem(`roms:${key}:${VERSION}`) != null; } catch { return false; }
}
