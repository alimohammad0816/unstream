import { useSyncExternalStore } from 'react'

/** Light or dark, or whatever the operating system says.
 *
 *  Every colour in the UI is a token in index.css, and the light theme is a
 *  second set of values for the same tokens under `html[data-theme='light']`.
 *  So switching theme is one attribute on <html>: nothing re-renders, and no
 *  component knows which theme it is drawn in. */
export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_PREFERENCES: ThemePreference[] = ['system', 'light', 'dark']

const KEY = 'unstream:theme'
const media =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null

function stored(): ThemePreference {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
  } catch {
    return 'system'
  }
}

let preference: ThemePreference = stored()
const listeners = new Set<() => void>()

function apply() {
  if (typeof document === 'undefined') return
  const resolved = preference === 'system' ? (media?.matches ? 'light' : 'dark') : preference
  document.documentElement.dataset.theme = resolved
}

export function setThemePreference(next: ThemePreference) {
  preference = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // Not remembered past this session; still applied now.
  }
  apply()
  for (const listener of listeners) listener()
}

// Applied when this module loads — imported by main.tsx before the first
// render — so a light-theme user never sees a dark frame first.
apply()
media?.addEventListener('change', () => {
  if (preference === 'system') apply()
})

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference)
}
