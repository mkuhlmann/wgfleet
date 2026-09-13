import { failure, type Failure } from './failure';
import { cidrContains, INTERFACE_NAME_REGEX, IPV4_ADDRESS_REGEX, isValidCidr, WG_LISTEN_PORT_MAX, WG_LISTEN_PORT_MIN } from './validation';

/**
 * The rules a server write has to satisfy that depend on this host's *other* servers, or on
 * more than one field of the request at once.
 *
 * Pure and io-free for the same reason lib/peerInvariants.ts is: the api and the server form
 * decide with the same function. Before this module there was no server-side equivalent at all
 * - the form checked one rule the api did not have (and disagreed with it about what a valid
 * wgAddress is), while the two cross-row rules the api did have, "that port is taken" and
 * "that address is outside the range", could only be discovered by submitting.
 */

/** The server columns these rules read. Structural, so the app's server shape satisfies it. */
export type InvariantServer = {
	id: string;
	interfaceName: string;
	wgListenPort: number;
	cidrRange: string;
	wgAddress: string;
};

export type ServerInvariantSnapshot = {
	/** every server on this host, including the one being edited */
	servers: Pick<InvariantServer, 'id' | 'interfaceName' | 'wgListenPort'>[];
};

/** The subset of a server write these rules care about. `undefined` means "leave unchanged". */
export type ServerInvariantRequest = {
	interfaceName?: string;
	wgListenPort?: number;
	cidrRange?: string;
	wgAddress?: string;
	wgEndpoint?: string;
	reservedIps?: number;
};

export function checkServerInvariants(snapshot: ServerInvariantSnapshot, current: InvariantServer | null, request: ServerInvariantRequest): Failure | null {
	const interfaceName = request.interfaceName ?? current?.interfaceName;
	const wgListenPort = request.wgListenPort ?? current?.wgListenPort;
	const cidrRange = request.cidrRange ?? current?.cidrRange;
	const wgAddress = request.wgAddress ?? current?.wgAddress;

	if (interfaceName !== undefined && !INTERFACE_NAME_REGEX.test(interfaceName)) {
		return failure('Interface name may only contain letters, numbers and _=+.- and must be 1-15 characters', 'interfaceName');
	}

	if (request.wgEndpoint !== undefined && !request.wgEndpoint.trim()) {
		return failure('Endpoint is required - it is the address clients dial, so an empty one produces configs that connect to nothing', 'wgEndpoint');
	}

	if (request.reservedIps !== undefined && (!Number.isInteger(request.reservedIps) || request.reservedIps < 0)) {
		return failure('Reserved IPs must be zero or more', 'reservedIps');
	}

	if (wgListenPort !== undefined) {
		if (!Number.isInteger(wgListenPort) || wgListenPort < WG_LISTEN_PORT_MIN || wgListenPort > WG_LISTEN_PORT_MAX) {
			return failure(`Listen port must be between ${WG_LISTEN_PORT_MIN} and ${WG_LISTEN_PORT_MAX}`, 'wgListenPort');
		}

		// One udp socket per port on the host. An exit link's port is checked separately, in the
		// same spirit, by resolveExitListenPort (wg/peerIntake.ts).
		if (snapshot.servers.some((s) => s.id !== current?.id && s.wgListenPort === wgListenPort)) {
			return failure('Port already in use by another server', 'wgListenPort');
		}
	}

	if (interfaceName !== undefined && snapshot.servers.some((s) => s.id !== current?.id && s.interfaceName === interfaceName)) {
		return failure('Interface name already in use by another server', 'interfaceName');
	}

	if (cidrRange !== undefined && !isValidCidr(cidrRange)) {
		return failure('Invalid CIDR range', 'cidrRange');
	}

	if (wgAddress !== undefined) {
		if (!IPV4_ADDRESS_REGEX.test(wgAddress)) {
			return failure('Invalid IP address format. WireGuard addresses are IPv4 only.', 'wgAddress');
		}

		if (cidrRange !== undefined && !cidrContains(cidrRange, wgAddress)) {
			return failure('wgAddress is not in CIDR range', 'wgAddress');
		}
	}

	return null;
}
