// NEXUS-WEB-AUTHZ-001 — SSRF egress guard for config-supplied outbound URLs
// (alert webhooks: Slack/Discord/Teams/generic, and integration URLs).
//
// Threat model closed here:
//   - exotic schemes (file:, gopher:, data:, ftp:)  -> scheme allow-list
//   - alternate IP encodings (decimal 2130706433,    -> we NEVER parse the
//     octal 0177.0.0.1, hex 0x7f…, zero-padded)         hostname string; DNS
//                                                        lookup canonicalises it,
//                                                        then we range-check the IP
//   - IPv6 loopback/ULA/link-local + IPv4-mapped      -> BlockList + ::ffff: unwrap
//   - cloud metadata (169.254.169.254)                -> 169.254.0.0/16 blocked
//   - private / loopback ranges                       -> RFC1918 + 127/8 + …
//   - multiple A/AAAA records                         -> EVERY resolved IP must pass
//   - DNS rebinding (TOCTOU)                           -> the lookup hook of the
//     fetch dispatcher is what validates, so the IP we VALIDATE is the exact IP
//     undici DIALS. No second, unchecked resolution happens at connect time.
//   - open redirects to internal hosts                -> redirect: "error".
//
// `assertSafeOutboundUrl` is the cheap structural gate (scheme/credentials);
// `safeFetch` performs the request pinned to the validated address.

import { BlockList, isIP, isIPv4 } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { Agent } from "undici";

// Ranges that an outbound webhook must never reach. Enumerated explicitly so the
// list is auditable (and asserted by the SSRF guard regression test).
const BLOCK = new BlockList();
// IPv4
BLOCK.addSubnet("0.0.0.0", 8, "ipv4"); // "this" network / 0.0.0.0
BLOCK.addSubnet("10.0.0.0", 8, "ipv4"); // RFC1918
BLOCK.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT (RFC6598)
BLOCK.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
BLOCK.addSubnet("169.254.0.0", 16, "ipv4"); // link-local + 169.254.169.254 metadata
BLOCK.addSubnet("172.16.0.0", 12, "ipv4"); // RFC1918
BLOCK.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
BLOCK.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918
BLOCK.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
BLOCK.addAddress("255.255.255.255", "ipv4"); // broadcast
// IPv6
BLOCK.addAddress("::", "ipv6"); // unspecified
BLOCK.addAddress("::1", "ipv6"); // loopback
BLOCK.addSubnet("fc00::", 7, "ipv6"); // unique local (ULA)
BLOCK.addSubnet("fe80::", 10, "ipv6"); // link-local

// Unwrap IPv4-mapped IPv6 (both ::ffff:1.2.3.4 dotted and ::ffff:7f00:1 hex
// forms) so a mapped address can't smuggle a private v4 past the v4 BlockList.
function normalizeAddress(addr: string): { ip: string; family: 4 | 6 } {
  if (isIPv4(addr)) return { ip: addr, family: 4 };
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (dotted && isIPv4(dotted[1])) return { ip: dotted[1], family: 4 };
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isIPv4(v4)) return { ip: v4, family: 4 };
  }
  return { ip: addr, family: 6 };
}

// Single source of truth for "may this resolved IP be dialed?". Exported for the
// behavioural test: it proves rebinding is closed by feeding the validator the
// address set a hostile resolver would return AT CONNECT, not a literal URL.
export function isBlockedAddress(addr: string): boolean {
  const { ip, family } = normalizeAddress(addr);
  if (isIP(ip) === 0) return true; // not a parseable IP -> refuse (fail-closed)
  return BLOCK.check(ip, family === 4 ? "ipv4" : "ipv6");
}

// Throws if ANY resolved address is in a blocked range. Reused by the dispatcher
// lookup hook (connect-time) and available directly for tests.
export function assertAddressesAllowed(
  hostname: string,
  addresses: Array<{ address: string }>,
): void {
  if (addresses.length === 0) {
    throw new Error(`[net-guard] ${hostname} resolved to no address`);
  }
  for (const a of addresses) {
    if (isBlockedAddress(a.address)) {
      throw new Error(
        `[net-guard] ${hostname} resolves to blocked address ${a.address} (SSRF)`,
      );
    }
  }
}

// Structural gate: scheme allow-list + no embedded credentials. Cheap, synchronous,
// called at each outbound call-site so a bad URL fails fast before any I/O.
export function assertSafeOutboundUrl(rawUrl: string): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`[net-guard] invalid URL: ${String(rawUrl).slice(0, 120)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`[net-guard] scheme not allowed: ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new Error("[net-guard] credentials embedded in URL are not allowed");
  }
  // WEB-AUTHZ-001 — CRITICAL HOLE: an IP-LITERAL target (http://10.0.0.1,
  // http://169.254.169.254, http://[::1], http://127.0.0.1:6379) NEVER triggers
  // the dispatcher's lookup hook — undici skips DNS resolution for a literal —
  // so it BYPASSES the guard at connect. We therefore validate the IP literal
  // SYNCHRONOUSLY here, before any I/O. The lookup hook remains for hostnames
  // (resolution + anti-rebinding). Alternate forms (decimal 2130706433, octal)
  // are NOT IP literals in the isIP() sense → they go through lookup, which
  // canonicalises and blocks them.
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets [::1]
  if (isIP(host) !== 0 && isBlockedAddress(host)) {
    throw new Error(`[net-guard] blocked IP-literal target ${host} (SSRF)`);
  }
  return u;
}

// THE rebinding-closing piece: a dns.lookup-shaped hook used by undici's connect.
// It resolves once, validates EVERY returned address, and hands undici back the
// SAME addresses it validated — so the IP we checked is the IP that gets dialed.
// There is no separate, unchecked re-resolution at connect time.
function guardedLookup(
  hostname: string,
  options: { all?: boolean } & Record<string, unknown>,
  callback: (
    err: NodeJS.ErrnoException | null,
    address?: string | Array<{ address: string; family: number }>,
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err);
      return;
    }
    const list = Array.isArray(addresses) ? addresses : [addresses];
    try {
      assertAddressesAllowed(hostname, list);
    } catch (e) {
      callback(e as NodeJS.ErrnoException);
      return;
    }
    if (options && options.all) {
      callback(
        null,
        list.map((a) => ({ address: a.address, family: a.family })),
      );
    } else {
      callback(null, list[0].address, list[0].family);
    }
  });
}

// One shared dispatcher; the pinned lookup makes every connection it opens
// rebinding-safe. Reasonable timeouts so a sink can't hang the sender.
const guardedAgent = new Agent({
  connect: { lookup: guardedLookup as never },
  headersTimeout: 10_000,
  bodyTimeout: 10_000,
});

// Drop-in replacement for fetch on config-supplied URLs. Validates the URL
// structurally, refuses redirects (no hop to an internal host), and routes the
// request through the rebinding-safe dispatcher.
export async function safeFetch(
  rawUrl: string,
  init?: RequestInit,
): Promise<Response> {
  assertSafeOutboundUrl(rawUrl);
  return fetch(rawUrl, {
    ...init,
    redirect: "error",
    // @ts-expect-error: `dispatcher` is an undici extension to fetch's init.
    dispatcher: guardedAgent,
  });
}
