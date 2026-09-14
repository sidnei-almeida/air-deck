/** Reads a brand token from brand/tokens.css, for canvas code that can't use CSS variables. */
export function getComputedToken(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
