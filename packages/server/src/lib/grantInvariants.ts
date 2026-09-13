import { failure, type Failure } from './failure';
import { isIpv4Cidr, MAX_PORT_ENTRIES, PORTS_REGEX } from './validation';

/**
 * The rules one grant has to satisfy: that its src/dst references resolve on this server, and
 * that its protocol and ports agree.
 *
 * Pure and io-free, so the grant form decides with the function the api decides with. It used
 * to be neither shared nor stated once: `isValidPorts` existed twice (the copy in
 * GrantModal.vue dropped the `MAX_PORT_ENTRIES` check, so a 33-entry list passed the form and
 * 400ed), `isIpv4Cidr` existed twice, and "ports only when protocol is tcp or udp" existed only
 * on the server - the form merely *hid* the ports input for other protocols without clearing
 * it, so switching protocol with a port typed produced a 400 about a field no longer on screen.
 */

export type GrantRef = { kind: 'tag'; id: string | null | undefined } | { kind: 'peer'; id: string | null | undefined } | { kind: 'cidr'; cidr: string | null | undefined } | { kind: 'server' } | { kind: 'any' };

export type GrantInvariantRequest = {
	src: GrantRef;
	dst: GrantRef;
	protocol?: 'any' | 'tcp' | 'udp' | 'icmp' | null;
	ports?: string | null;
};

export type GrantInvariantSnapshot = {
	/** tag ids defined on this server */
	tagIds: string[];
	/** peer ids on this server */
	peerIds: string[];
};

const portsFailure = (ports: string): Failure | null => {
	// Whitespace around the separators is accepted: a human types this field, and the form's own
	// placeholder has always read `22, 8000-8100` - which the regex, applied to the raw string,
	// rejected. nft renders the stored value into `tcp dport { ... }`, where spaces are fine.
	const compact = ports.replace(/\s+/g, '');
	if (!PORTS_REGEX.test(compact)) return failure(`Invalid ports: ${ports}`, 'ports');

	const entries = compact.split(',');
	if (entries.length > MAX_PORT_ENTRIES) return failure(`Too many port entries (max ${MAX_PORT_ENTRIES}) - use a tag rather than listing them all`, 'ports');

	for (const entry of entries) {
		const [loStr, hiStr] = entry.split('-');
		const lo = Number(loStr);
		const hi = hiStr !== undefined ? Number(hiStr) : lo;
		if (lo < 1 || lo > 65535 || hi < 1 || hi > 65535 || lo > hi) return failure(`Invalid ports: ${ports}`, 'ports');
	}

	return null;
};

/** Ports are only meaningful for tcp/udp - nothing else has a port number to match on. */
export const checkGrantPorts = (protocol: string | null | undefined, ports: string | null | undefined): Failure | null => {
	if (!ports || !ports.trim()) return null;
	if (protocol !== 'tcp' && protocol !== 'udp') return failure('ports can only be set when protocol is tcp or udp', 'ports');

	return portsFailure(ports);
};

const checkRef = (snapshot: GrantInvariantSnapshot, ref: GrantRef, side: 'Source' | 'Destination', field: string): Failure | null => {
	switch (ref.kind) {
		case 'tag':
			if (!ref.id) return failure(`${field} is required when ${side.toLowerCase() === 'source' ? 'srcKind' : 'dstKind'} is "tag"`, field);
			if (!snapshot.tagIds.includes(ref.id)) return failure(`${side} tag ${ref.id} not found on this server`, field);
			return null;
		case 'peer':
			if (!ref.id) return failure(`${field} is required when ${side.toLowerCase() === 'source' ? 'srcKind' : 'dstKind'} is "peer"`, field);
			if (!snapshot.peerIds.includes(ref.id)) return failure(`${side} peer ${ref.id} not found on this server`, field);
			return null;
		case 'cidr':
			// ipv4-only - the firewall this feeds (wg/firewall.ts) is ipv4-only throughout
			if (!ref.cidr || !isIpv4Cidr(ref.cidr)) return failure(`Invalid or non-ipv4 CIDR: ${ref.cidr}`, field);
			return null;
		case 'server':
		case 'any':
			return null;
	}
};

export function checkGrantInvariants(snapshot: GrantInvariantSnapshot, request: GrantInvariantRequest): Failure | null {
	return checkRef(snapshot, request.src, 'Source', request.src.kind === 'peer' ? 'srcPeerId' : 'srcTagId') ?? checkRef(snapshot, request.dst, 'Destination', dstField(request.dst)) ?? checkGrantPorts(request.protocol, request.ports);
}

const dstField = (dst: GrantRef) => (dst.kind === 'peer' ? 'dstPeerId' : dst.kind === 'cidr' ? 'dstCidr' : 'dstTagId');
