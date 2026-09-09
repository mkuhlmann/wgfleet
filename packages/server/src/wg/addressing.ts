import IPCIDR from 'ip-cidr';

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
