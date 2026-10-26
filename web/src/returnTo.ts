/** Build OIDC / login returnTo from the current location (path + query + hash). */
export function buildReturnTo(
  loc: Pick<Location, "pathname" | "search" | "hash"> = location,
): string {
  return `${loc.pathname}${loc.search}${loc.hash}`;
}

/**
 * Same-origin relative returnTo only. Rejects protocol-relative (`//evil…`),
 * absolute external URLs, and auth callback paths. Returns `/` when unsafe.
 */
export function sanitizeReturnTo(
  value: unknown,
  origin: string = typeof location !== "undefined"
    ? location.origin
    : "http://localhost",
): string {
  if (typeof value !== "string" || value.length === 0) return "/";
  // Relative path only; reject protocol-relative and backslash host tricks.
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/";
  }
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return "/";
    if (url.pathname.startsWith("//")) return "/";
    if (url.pathname === "/auth/callback" || url.pathname === "/dev-login") {
      return "/";
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
