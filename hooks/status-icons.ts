// The band's cache-state mark. Drawn as a vector for the desktop surface and as a
// plain character in a terminal, so there is no binary artwork to keep in sync.

export type CacheMark = 'warm' | 'cold' | 'unknown'

/** Hue per state and theme, also used for the band's text colour. */
export const markInk: Record<'light' | 'dark', Record<CacheMark, string>> = {
  light: { warm: '#2f7d4f', cold: '#c15f3c', unknown: '#6b665c' },
  dark: { warm: '#6cc08b', cold: '#d97757', unknown: '#9b958a' },
}

/** One glyph per state for terminals, where a drawn image is not worth its columns. */
export const markGlyph: Record<CacheMark, string> = { warm: '●', cold: '○', unknown: '◐' }

/** A dot whose fill says the state: solid warm, hollow cold, half unknown. */
export function markSvg(state: CacheMark, theme: 'light' | 'dark'): string {
  const ink = markInk[theme][state]
  const body = state === 'warm'
    ? `<circle cx="9" cy="9" r="5.5" fill="${ink}"/>`
    : state === 'cold'
      ? `<circle cx="9" cy="9" r="5" fill="none" stroke="${ink}" stroke-width="2"/>`
      : `<path d="M9 3.5a5.5 5.5 0 0 1 0 11z" fill="${ink}"/><circle cx="9" cy="9" r="5" fill="none" stroke="${ink}" stroke-width="2"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" role="img" aria-label="cache ${state}">${body}</svg>`
}
