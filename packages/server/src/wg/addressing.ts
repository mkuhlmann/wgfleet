import IPCIDR from 'ip-cidr';
import { parseCidrList } from '@server/lib/validation';
import { failure, type Failure } from '@server/lib/failure';
import { checkAdvertisedRoute } from '@server/lib/peerInvariants';
// normalizeCidr lives in lib/validation.ts so the peer form can normalise as it validates
export { normalizeCidr } from '@server/lib/validation';
import { normalizeCidr } from '@server/lib/validation';

export type ResolvePeerAddressResult = { ok: true; ip: string } | { ok: false; failure: Failure };

/**
 * Resolves the wgAddress a peer should get: validates a caller-requested address against the
 * server's CIDR range and existing peers, or auto-allocates the next free one starting from
 * reservedIps. Pure - existingAddresses is a pre-fetched snapshot, never queried here.
 */
export function resolvePeerAddress(cidrRange: string, reservedIps: number, existingAddresses: Set<string>, options?: { requested?: string }): ResolvePeerAddressResult {
	const cidr = new IPCIDR(cidrRange);

	if (options?.requested) {
		if (!cidr.contains(options.requested)) {
			return { ok: false, failure: failure('wgAddress is not in CIDR range', 'wgAddress') };
		}

		if (existingAddresses.has(options.requested)) {
			return { ok: false, failure: failure('IP already in use', 'wgAddress') };
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

	return { ok: false, failure: failure('No more IPs available', 'wgAddress') };
}

/**
 * Do two CIDR blocks share any address? Prefixes are aligned by the time this is called
 * (normalizeCidr above), so two blocks are either nested or disjoint - it is enough to ask
 * whether either one contains the other's network address, which also covers the equal case.
 */
export const cidrsOverlap = (a: string, b: string): boolean => new IPCIDR(a).contains(new IPCIDR(b).start() as string) || new IPCIDR(b).contains(new IPCIDR(a).start() as string);

// Defined in lib/exitTopology.ts (which has no db import, so the frontend can bundle it) and
// re-exported here, where most of its callers already look for it.
export { advertisedRoutesOf } from '@server/lib/exitTopology';

export type ResolveAdvertisedRoutesResult = { ok: true; routes: string[] } | { ok: false; failure: Failure };

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
		// format and the /0 rule - shared with the peer form, see lib/peerInvariants.ts
		const invalid = checkAdvertisedRoute(entry);
		if (invalid) return { ok: false, failure: invalid };

		const route = normalizeCidr(entry);

		// The interface's own range is reached through the connected route from the server's
		// Address; a peer claiming part of it would take over routing for peers on the same
		// interface, which is what grants are for.
		if (cidrsOverlap(route, cidrRange)) {
			return { ok: false, failure: failure(`${route} overlaps this server's own range (${cidrRange}) - advertise a network behind the peer, not part of the vpn subnet`, 'advertisedRoutes') };
		}

		const clash = routes.find((existing) => cidrsOverlap(existing, route));
		if (clash) {
			return { ok: false, failure: failure(`${route} overlaps ${clash}, which this peer already advertises`, 'advertisedRoutes') };
		}

		routes.push(route);
	}

	for (const route of routes) {
		for (const owner of reserved) {
			const clash = owner.routes.find((existing) => cidrsOverlap(existing, route));
			if (clash) {
				return { ok: false, failure: failure(`${route} overlaps ${clash}, already used by ${owner.label}. A prefix can have only one owner - on a wireguard interface, and in the host's main routing table.`, 'advertisedRoutes') };
			}
		}
	}

	return { ok: true, routes };
}
