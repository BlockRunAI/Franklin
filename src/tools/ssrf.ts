/**
 * Basic SSRF guard for model-driven fetches (WebFetch, reference-image resolve).
 *
 * Blocks loopback / private / link-local / cloud-metadata hosts so a steered
 * model can't make Franklin fetch `http://169.254.169.254/...` (cloud creds) or
 * `http://127.0.0.1:<port>/...` (the local proxy / panel). Literal-host based:
 * it does NOT resolve DNS or re-validate each redirect hop, so it stops the
 * common direct-IP/localhost cases, not a DNS-rebinding or redirect attack.
 */
// Named cloud-metadata endpoints that aren't `*.internal` (AWS legacy alias,
// GCP short form). They resolve to 169.254.169.254 / a link-local address.
const METADATA_HOSTS = new Set([
  'metadata', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal',
]);

export function isBlockedSsrfHost(hostname: string): boolean {
  // Normalize: lowercase, strip IPv6 brackets, strip a single trailing dot
  // (`localhost.` / `127.0.0.1.` resolve the same as without it).
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  // Cloud-metadata hostnames resolve (at the OS/fetch layer, AFTER this literal
  // check) to 169.254.169.254 / a NAT address, so blocking only the IP misses the
  // named form. `.internal` is the ICANN-reserved private TLD (GCE
  // metadata.google.internal, EC2 *.ec2.internal) — denied wholesale.
  if (h.endsWith('.internal')) return true;
  if (METADATA_HOSTS.has(h)) return true;

  // IPv6 literal (only IPv6 hosts contain a colon — so the fc/fd/fe80 ULA checks
  // can't false-positive on public DNS names like fda.gov / fcc.gov).
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;                          // loopback / unspecified
    if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local / ULA
    // NAT64 (`64:ff9b::a.b.c.d` / `64:ff9b::hhhh:hhhh`) embeds an IPv4 that a NAT64
    // gateway routes to — decode and recheck it like the IPv4-mapped form below.
    const nat64 = h.match(/^64:ff9b::(.+)$/);
    if (nat64) {
      const t = nat64[1];
      if (t.includes('.')) return isBlockedSsrfHost(t);
      const seg = t.split(':');
      if (seg.length === 2) {
        const n = ((parseInt(seg[0], 16) << 16) | parseInt(seg[1], 16)) >>> 0;
        return isBlockedSsrfHost(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
      }
    }
    // IPv4-mapped IPv6 (`::ffff:a.b.c.d` or `::ffff:hhhh:hhhh`) → recheck the embedded v4.
    const mapped = h.match(/::ffff:(.+)$/);
    if (mapped) {
      const tail = mapped[1];
      if (tail.includes('.')) return isBlockedSsrfHost(tail);
      const hx = tail.split(':');
      if (hx.length === 2) {
        const n = ((parseInt(hx[0], 16) << 16) | parseInt(hx[1], 16)) >>> 0;
        return isBlockedSsrfHost(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
      }
    }
    return false;
  }

  // IPv4 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]);
    if (a === 127 || a === 0 || a === 10) return true;       // loopback / this-host / private
    if (a === 169 && b === 254) return true;                 // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;        // private
    if (a === 192 && b === 168) return true;                 // private
    if (a === 100 && b === 100) return true;                 // Alibaba Cloud metadata (100.100.100.200)
    if (a === 192 && b === 0 && c === 0) return true;        // Oracle OCI metadata (192.0.0.192) / 192.0.0.0/24
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT 100.64.0.0/10
  }
  return false;
}

/**
 * Fetch with per-redirect-hop SSRF re-validation. Node's `fetch` follows
 * redirects automatically, so a public URL can 302 to 169.254.169.254 / a
 * loopback service — checking only the initial host is useless. This follows
 * redirects MANUALLY, re-running isBlockedSsrfHost on every hop. `allow=true`
 * (FRANKLIN_ALLOW_PRIVATE_FETCH) skips the check for local dev servers.
 */
export async function ssrfSafeFetch(
  url: string,
  init: RequestInit & { allowPrivate?: boolean } = {},
  maxHops = 5,
): Promise<Response> {
  const { allowPrivate, ...fetchInit } = init;
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const host = new URL(current).hostname;
    if (!allowPrivate && isBlockedSsrfHost(host)) {
      throw new Error(`SSRF: refusing to fetch a private/loopback/metadata address: ${host}`);
    }
    const res = await fetch(current, { ...fetchInit, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      current = new URL(loc, current).href; // resolve relative redirects
      continue;
    }
    return res;
  }
  throw new Error('SSRF: too many redirects');
}
