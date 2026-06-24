/**
 * Basic SSRF guard for model-driven fetches (WebFetch, reference-image resolve).
 *
 * Blocks loopback / private / link-local / cloud-metadata hosts so a steered
 * model can't make Franklin fetch `http://169.254.169.254/...` (cloud creds) or
 * `http://127.0.0.1:<port>/...` (the local proxy / panel). Literal-host based:
 * it does NOT resolve DNS or re-validate each redirect hop, so it stops the
 * common direct-IP/localhost cases, not a DNS-rebinding or redirect attack.
 */
export function isBlockedSsrfHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;

  // IPv6 loopback / unspecified / link-local (fe80::/10) / unique-local (fc00::/7)
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;

  // IPv4 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127 || a === 0 || a === 10) return true;       // loopback / this-host / private
    if (a === 169 && b === 254) return true;                 // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;        // private
    if (a === 192 && b === 168) return true;                 // private
  }
  return false;
}
