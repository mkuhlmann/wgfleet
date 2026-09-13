import { describe, expect, it } from 'bun:test';
import { checkServerInvariants } from './serverInvariants';
import { checkTagInvariants } from './tagInvariants';
import { checkGrantInvariants } from './grantInvariants';
import { checkAdvertisedRoute, checkPeerInvariants } from './peerInvariants';
import { cidrContains, normalizeCidr } from './validation';

// These modules are pure, io-free and shared with the Vue forms, which is exactly the shape
// that should be driven directly - every rule in them used to be reachable only through
// `app.handle(new Request(...))`, asserted as a 400 with a message substring.

describe('checkServerInvariants', () => {
	const snapshot = { servers: [{ id: 's-other', interfaceName: 'wg1', wgListenPort: 51821 }] };
	const write = { interfaceName: 'wg0', cidrRange: '10.8.0.0/24', wgAddress: '10.8.0.1', wgListenPort: 51820, wgEndpoint: 'vpn.example.com:51820', reservedIps: 50 };

	it('accepts a well-formed server', () => {
		expect(checkServerInvariants(snapshot, null, write)).toBeNull();
	});

	it('refuses a port another server already listens on, naming the port field', () => {
		expect(checkServerInvariants(snapshot, null, { ...write, wgListenPort: 51821 })).toEqual({ message: 'Port already in use by another server', field: 'wgListenPort' });
	});

	it('lets a server keep its own port on update', () => {
		const current = { id: 's-other', interfaceName: 'wg1', wgListenPort: 51821, cidrRange: '10.9.0.0/24', wgAddress: '10.9.0.1' };
		expect(checkServerInvariants(snapshot, current, { wgListenPort: 51821 })).toBeNull();
	});

	it('refuses an interface name another server already uses', () => {
		expect(checkServerInvariants(snapshot, null, { ...write, interfaceName: 'wg1' })).toMatchObject({ field: 'interfaceName' });
	});

	it('refuses an address outside the range', () => {
		expect(checkServerInvariants(snapshot, null, { ...write, wgAddress: '10.9.0.1' })).toEqual({ message: 'wgAddress is not in CIDR range', field: 'wgAddress' });
	});

	it('accepts an address that carries its own prefix', () => {
		// IPV4_ADDRESS_REGEX permits one and wg/config.ts honours it, but the check this
		// replaced (IPCIDR.contains) refused exactly these - so the form called it valid and
		// the api came back 400.
		expect(checkServerInvariants(snapshot, null, { ...write, wgAddress: '10.8.0.1/24' })).toBeNull();
	});

	it('checks a PATCH against the range it is being given, not the stored one', () => {
		const current = { id: 's0', interfaceName: 'wg0', wgListenPort: 51820, cidrRange: '10.8.0.0/24', wgAddress: '10.8.0.1' };
		expect(checkServerInvariants(snapshot, current, { cidrRange: '10.9.0.0/24' })).toMatchObject({ field: 'wgAddress' });
		expect(checkServerInvariants(snapshot, current, { cidrRange: '10.9.0.0/24', wgAddress: '10.9.0.1' })).toBeNull();
	});

	it('refuses an empty endpoint and a negative reservedIps, neither of which was checked anywhere before', () => {
		expect(checkServerInvariants(snapshot, null, { ...write, wgEndpoint: '  ' })).toMatchObject({ field: 'wgEndpoint' });
		expect(checkServerInvariants(snapshot, null, { ...write, reservedIps: -1 })).toMatchObject({ field: 'reservedIps' });
	});

	it('refuses a malformed interface name and an unparseable range', () => {
		expect(checkServerInvariants(snapshot, null, { ...write, interfaceName: 'this-name-is-far-too-long' })).toMatchObject({ field: 'interfaceName' });
		expect(checkServerInvariants(snapshot, null, { ...write, cidrRange: '999.1.1.0/24' })).toMatchObject({ field: 'cidrRange' });
	});
});

describe('checkTagInvariants', () => {
	const snapshot = { tags: [{ id: 't0', name: 'office' }] };

	it('accepts a well-formed, unused name', () => {
		expect(checkTagInvariants(snapshot, null, { name: 'servers' })).toBeNull();
	});

	it('refuses a duplicate name, but lets a tag keep its own', () => {
		expect(checkTagInvariants(snapshot, null, { name: 'office' })).toMatchObject({ field: 'name' });
		expect(checkTagInvariants(snapshot, { id: 't0', name: 'office' }, { name: 'office' })).toBeNull();
	});

	it('refuses names nft could not carry as an identifier', () => {
		for (const name of ['Office', '-office', 'office-', 'of fice', '']) {
			expect(checkTagInvariants(snapshot, null, { name })).toMatchObject({ field: 'name' });
		}
	});
});

describe('checkGrantInvariants', () => {
	const snapshot = { tagIds: ['t0'], peerIds: ['p0'] };
	const allow = { src: { kind: 'tag', id: 't0' } as const, dst: { kind: 'any' } as const };

	it('accepts a grant whose references resolve', () => {
		expect(checkGrantInvariants(snapshot, allow)).toBeNull();
	});

	it('refuses an unresolvable reference on either side', () => {
		expect(checkGrantInvariants(snapshot, { ...allow, src: { kind: 'tag', id: 'gone' } })).toMatchObject({ field: 'srcTagId' });
		expect(checkGrantInvariants(snapshot, { ...allow, dst: { kind: 'peer', id: 'gone' } })).toMatchObject({ field: 'dstPeerId' });
	});

	it('refuses a non-ipv4 destination cidr', () => {
		expect(checkGrantInvariants(snapshot, { ...allow, dst: { kind: 'cidr', cidr: 'fd00::/64' } })).toMatchObject({ field: 'dstCidr' });
		expect(checkGrantInvariants(snapshot, { ...allow, dst: { kind: 'cidr', cidr: '192.168.1.0/24' } })).toBeNull();
	});

	it('refuses ports on a protocol that has none', () => {
		expect(checkGrantInvariants(snapshot, { ...allow, protocol: 'icmp', ports: '22' })).toEqual({ message: 'ports can only be set when protocol is tcp or udp', field: 'ports' });
		expect(checkGrantInvariants(snapshot, { ...allow, protocol: 'tcp', ports: '22' })).toBeNull();
	});

	it('bounds the port list, which the form used to let through', () => {
		// the client copy of this rule omitted the max-entries check, so a 33-entry list passed
		// validation and came back 400
		const tooMany = Array.from({ length: 33 }, (_, i) => String(i + 1)).join(',');
		expect(checkGrantInvariants(snapshot, { ...allow, protocol: 'tcp', ports: tooMany })).toMatchObject({ field: 'ports' });
	});

	it('refuses an out-of-range or inverted port range', () => {
		expect(checkGrantInvariants(snapshot, { ...allow, protocol: 'tcp', ports: '0' })).toMatchObject({ field: 'ports' });
		expect(checkGrantInvariants(snapshot, { ...allow, protocol: 'tcp', ports: '8100-8000' })).toMatchObject({ field: 'ports' });
		expect(checkGrantInvariants(snapshot, { ...allow, protocol: 'udp', ports: '22, 8000-8100' })).toBeNull();
	});
});

describe('checkPeerInvariants', () => {
	const exitNode = { id: 'n0', friendlyName: 'gateway', wgAddress: '10.8.0.2', isExitNode: true, exitPeerId: null };
	const client = { id: 'c0', friendlyName: null, wgAddress: '10.8.0.3', isExitNode: false, exitPeerId: 'n0' };
	const snapshot = { peers: [exitNode, client], tagIds: ['t0'] };

	it('names the field each rule is about, rather than one catch-all', () => {
		expect(checkPeerInvariants(snapshot, null, { tagIds: ['gone'] })).toMatchObject({ field: 'tagIds' });
		expect(checkPeerInvariants(snapshot, null, { isExitNode: true, exitPeerId: 'n0' })).toMatchObject({ field: 'isExitNode' });
		expect(checkPeerInvariants(snapshot, client, { exitPeerId: 'c0' })).toMatchObject({ field: 'exitPeerId' });
		expect(checkPeerInvariants(snapshot, null, { exitPeerId: 'gone' })).toMatchObject({ field: 'exitPeerId' });
		expect(checkPeerInvariants(snapshot, null, { exitPeerId: 'c0' })).toMatchObject({ field: 'exitPeerId' });
	});

	it('refuses to strip an exit node that still has clients, naming them', () => {
		const result = checkPeerInvariants(snapshot, exitNode, { isExitNode: false });
		expect(result?.message).toContain('10.8.0.3');
		expect(result?.field).toBe('isExitNode');
	});

	it('allows the write once the last client has moved off', () => {
		expect(checkPeerInvariants({ peers: [exitNode], tagIds: [] }, exitNode, { isExitNode: false })).toBeNull();
	});
});

describe('checkAdvertisedRoute', () => {
	it('accepts an ipv4 prefix', () => {
		expect(checkAdvertisedRoute('192.168.1.0/24')).toBeNull();
	});

	it('refuses a non-ipv4 prefix and a default route', () => {
		expect(checkAdvertisedRoute('fd00::/64')).toMatchObject({ field: 'advertisedRoutes' });
		expect(checkAdvertisedRoute('0.0.0.0/0')?.message).toContain('exit node');
	});
});

describe('cidr arithmetic', () => {
	it('decides containment the way the api used to need ip-cidr for', () => {
		expect(cidrContains('10.8.0.0/24', '10.8.0.1')).toBe(true);
		expect(cidrContains('10.8.0.0/24', '10.8.1.1')).toBe(false);
		expect(cidrContains('10.8.0.0/16', '10.8.255.254')).toBe(true);
		expect(cidrContains('0.0.0.0/0', '8.8.8.8')).toBe(true);
		expect(cidrContains('10.8.0.0/24', '10.8.0.1/32')).toBe(true);
		expect(cidrContains('not-a-cidr', '10.8.0.1')).toBe(false);
	});

	it('network-aligns a prefix with host bits set', () => {
		expect(normalizeCidr('192.168.1.5/24')).toBe('192.168.1.0/24');
		expect(normalizeCidr('10.0.0.0/8')).toBe('10.0.0.0/8');
		expect(normalizeCidr('172.16.31.200/20')).toBe('172.16.16.0/20');
	});
});
