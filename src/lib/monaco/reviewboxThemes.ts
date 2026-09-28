/** Caller hint for light/dark; the shared editor observes the personal code theme. */
export function reviewboxTheme(dark: boolean | undefined) {
  return dark === false ? "reviewbox-light" : "reviewbox-dark"
}
