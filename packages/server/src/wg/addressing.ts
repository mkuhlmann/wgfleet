import IPCIDR from 'ip-cidr';
import { CIDR_REGEX, parseCidrList } from '@server/lib/validation';

export type ResolvePeerAddressResult = { ok: true; ip: string } | { ok: false; message: string };

/**
 * Resolves the wgAddress a peer should get: validates a caller-requested address against the
 * server's CIDR range and existing peers, or auto-allocates the next free one starting from
 * reservedIps. Pure - existingAddresses is a pre-fetched snapshot, never queried here.
 */
export function resolvePeerAddress(cidrRange: string, reservedIps: number, existingAddresses: Set<string>, options?: { requested?: string }): ResolvePeerAddressResult {
	const cidr = new IPCIDR(cidrRange);

	if (options?.requested) {
		if (!cidr.contains(options.requested)) {
			return { ok: false, message: 'wgAddress is not in CIDR range' };
		}

		if (existingAddresses.has(options.requested)) {
			return { ok: false, message: 'IP already in use' };
		}

		return { ok: true, ip: options.requested };
	}

	const networkAddress = cidr.start() as string;
	const broadcastAddress = cidr.end() as string;
	const rangeSize = Number(cidr.size);

	for (let fromIp = reservedIps; fromIp < rangeSize; fromIp++) {
		const candidates = cidr.toArray({ from: fromIp, limit: 1 });
		if (candidates.length === 0) break;

		const candidate = candidates[0];
		if (candidate !== networkAddress && candidate !== broadcastAddress && !existingAddresses.has(candidate)) {
			return { ok: true, ip: candidate };
		}
	}

	return { ok: false, message: 'No more IPs available' };
}

/**
 * Network address + prefix for a CIDR whose host bits may be set - `192.168.1.5/24` becomes
 * `192.168.1.0/24`. Both `ip route` and nft reject an unaligned prefix outright (nft: "Interval
 * is not aligned"), and CIDR_REGEX admits one, so anything that reaches a generated command or
 * ruleset has to be normalised first.
 */
export const normalizeCidr = (cidr: string): string => `${new IPCIDR(cidr).start()}/${cidr.split('/')[1]}`;

/**
 * Do two CIDR blocks share any address? Prefixes are aligned by the time this is called
 * (normalizeCidr above), so two blocks are either nested or disjoint - it is enough to ask
 * whether either one contains the other's network address, which also covers the equal case.
 */
export const cidrsOverlap = (a: string, b: string): boolean => new IPCIDR(a).contains(new IPCIDR(b).start() as string) || new IPCIDR(b).contains(new IPCIDR(a).start() as string);

/**
 * The subnet routes a peer advertises, decoded from its comma-separated column. The one place
 * that knows `peers.advertisedRoutes` is a list rather than a single value - config rendering,
 * hub routing, the firewall and the api all go through here instead of splitting the string
 * themselves. Entries are already validated and network-aligned on write
 * (resolveAdvertisedRoutes below), so callers can interpolate them straight into a command.
 */
export const advertisedRoutesOf = (peer: { advertisedRoutes: string | null }): string[] => parseCidrList(peer.advertisedRoutes);

export type ResolveAdvertisedRoutesResult = { ok: true; routes: string[] } | { ok: false; message: string };

/**
 * Validates and normalises the subnet routes one peer advertises (`peers.advertisedRoutes`,
 * applied by wg/exitRouting.ts). Pure: `reserved` is a pre-fetched snapshot, never queried
 * here.
 *
 * The overlap checks are the whole point, and they run at **two** scopes because two different
 * things break:
 *
 *   - Per interface, wireguard cryptokey routing has exactly one owner per prefix, so two
 *     peers advertising overlapping ranges is the direct analogue of two exit nodes - the
 *     config lists the same destination twice and the second advertiser silently steals the
 *     first one's traffic.
 *   - Per *host*, the route itself lives in the main routing table (wg/exitRouting.ts), which
 *     also has one owner per destination. So a prefix already advertised on another interface,
 *     or covered by another interface's own `cidrRange` (whose connected route
 *     `ip route replace` would happily overwrite), is equally unusable.
 *
 * `reserved` therefore carries every prefix already owned by anything on this host, and only
 * `cidrRange` - this peer's own server - is called out separately, for a clearer message.
 * An exact-duplicate check would be too weak for either scope: `192.168.0.0/16` swallows a
 * neighbour's `192.168.1.0/24` just as completely.
 */
export function resolveAdvertisedRoutes(input: string | null | undefined, cidrRange: string, reserved: { label: string; routes: string[] }[]): ResolveAdvertisedRoutesResult {
	const entries = parseCidrList(input);

	const routes: string[] = [];

	for (const entry of entries) {
		if (!CIDR_REGEX.test(entry)) {
			return { ok: false, message: `Invalid or non-ipv4 CIDR: ${entry}` };
		}

		// A /0 advertisement is an exit node wearing the wrong hat: it claims the same
		// AllowedIPs the exit node owns, so on an interface that has one the two would collide
		// outright, and on one that doesn't it would make the advertiser a de-facto exit node
		// while bypassing every invariant that role carries (one per interface, exitPeerId as
		// the permission). Point the operator at the feature that actually models this.
		if (entry.endsWith('/0')) {
			return { ok: false, message: 'A default route (/0) is what an exit node advertises - mark the peer as an exit node instead of advertising 0.0.0.0/0 as a subnet route' };
		}

		const route = normalizeCidr(entry);

		// The interface's own range is reached through the connected route from the server's
		// Address; a peer claiming part of it would take over routing for peers on the same
		// interface, which is what grants are for.
		if (cidrsOverlap(route, cidrRange)) {
			return { ok: false, message: `${route} overlaps this server's own range (${cidrRange}) - advertise a network behind the peer, not part of the vpn subnet` };
		}

		const clash = routes.find((existing) => cidrsOverlap(existing, route));
		if (clash) {
			return { ok: false, message: `${route} overlaps ${clash}, which this peer already advertises` };
		}

		routes.push(route);
	}

	for (const route of routes) {
		for (const owner of reserved) {
			const clash = owner.routes.find((existing) => cidrsOverlap(existing, route));
			if (clash) {
				return { ok: false, message: `${route} overlaps ${clash}, already used by ${owner.label}. A prefix can have only one owner - on a wireguard interface, and in the host's main routing table.` };
			}
		}
	}

	return { ok: true, routes };
}
