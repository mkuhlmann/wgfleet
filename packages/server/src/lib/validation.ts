// Shared between the server's TypeBox schemas and the app's client-side form validation
// (ServerModal.vue, PeerModal.vue) - the app imports server code directly (see CLAUDE.md), so
// these are the single source of truth for both instead of two hand-mirrored copies.

export const INTERFACE_NAME_REGEX = /^[a-zA-Z0-9_=+.-]{1,15}$/;
export const CIDR_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[1-2][0-9]|3[0-2])$/;

// wgAddress (server gateway or peer address) may carry an optional /prefix - see wg/config.ts,
// which appends a default one (/24 for a server, /32 for a peer) only when the stored value
// doesn't already include one.
export const IPV4_ADDRESS_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?:\/(?:[0-9]|[1-2][0-9]|3[0-2]))?$/;

export const WG_LISTEN_PORT_MIN = 1;
export const WG_LISTEN_PORT_MAX = 65535;

// Tag names are nft-comment and url safe, and short enough to read in a ruleset.
export const TAG_NAME_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// comma-separated ports/ranges, e.g. "22,80,8000-8100" - each endpoint 1-65535, lo <= hi
export const PORTS_REGEX = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/;
// an nft `dport { ... }` set stays readable and bounded; a grant needing more wants a tag
export const MAX_PORT_ENTRIES = 32;

/**
 * ipv4-only, because everything downstream is: `ip daddr <cidr>` is nft's ipv4-specific match
 * and rejects an ipv6 literal outright (`nft -f` exits 1), and `ip -4 route` is the same story.
 * Identical to CIDR_REGEX - named separately because callers ask two different questions of it.
 */
export const isIpv4Cidr = (value: string) => CIDR_REGEX.test(value);

/** An ipv4 address as a number, or null when it isn't one. Any trailing /prefix is ignored. */
const ipv4ToInt = (value: string): number | null => {
	const octets = value.split('/')[0].split('.');
	if (octets.length !== 4) return null;

	let result = 0;
	for (const octet of octets) {
		if (!/^\d{1,3}$/.test(octet)) return null;
		const part = Number(octet);
		if (part > 255) return null;
		result = result * 256 + part;
	}
	return result;
};

/** Whether `cidr` is a well-formed ipv4 network. */
export const isValidCidr = (cidr: string): boolean => isIpv4Cidr(cidr) && ipv4ToInt(cidr) !== null;

/**
 * Whether an ipv4 address falls inside a CIDR range. Hand-rolled rather than delegating to
 * `ip-cidr` so this module stays dependency-free and the app can run the same check the api
 * runs - the server form used to be unable to ask this at all, so "wgAddress is not in CIDR
 * range" always cost a round trip.
 *
 * A trailing /prefix on `address` is ignored rather than rejected: wgAddress may carry one
 * (see IPV4_ADDRESS_REGEX above, and wg/config.ts's interfaceAddress), and the check this
 * replaced refused exactly those values - so a value the form called valid came back 400.
 */
export const cidrContains = (cidr: string, address: string): boolean => {
	if (!isIpv4Cidr(cidr)) return false;

	const base = ipv4ToInt(cidr);
	const ip = ipv4ToInt(address);
	if (base === null || ip === null) return false;

	const prefix = Number(cidr.split('/')[1]);
	if (prefix === 0) return true;

	const mask = (0xffffffff << (32 - prefix)) >>> 0;
	return (base & mask) >>> 0 === (ip & mask) >>> 0;
};

/** An ipv4 address, from the number form. */
const intToIpv4 = (value: number): string => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');

/**
 * Network address + prefix for a CIDR whose host bits may be set - `192.168.1.5/24` becomes
 * `192.168.1.0/24`. Both `ip route` and nft reject an unaligned prefix outright (nft: "Interval
 * is not aligned"), and CIDR_REGEX admits one, so anything that reaches a generated command or
 * ruleset has to be normalised first.
 *
 * Lives here rather than in wg/addressing.ts so the peer form can normalise as it validates -
 * it used to accept `192.168.1.5/24`, the api silently rewrote it, and the input went on
 * showing the value the operator typed until the next refetch.
 */
export const normalizeCidr = (cidr: string): string => {
	const base = ipv4ToInt(cidr);
	const prefix = Number(cidr.split('/')[1]);
	if (base === null || !Number.isInteger(prefix)) return cidr;

	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return `${intToIpv4((base & mask) >>> 0)}/${prefix}`;
};

/**
 * Splits the comma-separated CIDR list stored in `peers.advertisedRoutes` (and typed into the
 * peer form) into its entries. Tolerant of whitespace, newlines and trailing commas, because
 * a human types this field and pasting a list with spaces after the commas must not turn into
 * a validation error. Deliberately does *not* validate - CIDR_REGEX above and
 * resolveAdvertisedRoutes (wg/addressing.ts, which also network-aligns each entry) do that;
 * this only has to agree about what the separators are.
 */
export const parseCidrList = (value: string | null | undefined): string[] =>
	(value ?? '')
		.split(/[\s,]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
