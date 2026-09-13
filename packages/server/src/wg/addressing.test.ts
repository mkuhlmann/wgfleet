import { describe, expect, it } from 'bun:test';
import { advertisedRoutesOf, cidrsOverlap, normalizeCidr, resolveAdvertisedRoutes, resolvePeerAddress } from './addressing';

describe('resolvePeerAddress', () => {
	describe('requested address', () => {
		it('accepts a requested address inside the range and not taken', () => {
			const result = resolvePeerAddress('10.20.20.0/24', 50, new Set(), { requested: '10.20.20.5' });
			expect(result).toEqual({ ok: true, ip: '10.20.20.5' });
		});

		it('rejects a requested address outside the CIDR range', () => {
			const result = resolvePeerAddress('10.20.20.0/24', 50, new Set(), { requested: '10.20.21.5' });
			expect(result).toEqual({ ok: false, failure: { message: 'wgAddress is not in CIDR range', field: 'wgAddress' } });
		});

		it('rejects a requested address already in use', () => {
			const result = resolvePeerAddress('10.20.20.0/24', 50, new Set(['10.20.20.5']), { requested: '10.20.20.5' });
			expect(result).toEqual({ ok: false, failure: { message: 'IP already in use', field: 'wgAddress' } });
		});

		it('rejects an IPv6 address against an IPv4 CIDR rather than misinterpreting it', () => {
			const result = resolvePeerAddress('10.20.20.0/24', 50, new Set(), { requested: '2001:db8::1' });
			expect(result).toEqual({ ok: false, failure: { message: 'wgAddress is not in CIDR range', field: 'wgAddress' } });
		});
	});

	describe('auto-allocate', () => {
		it('picks the first free address starting from reservedIps', () => {
			const result = resolvePeerAddress('10.20.20.0/24', 50, new Set());
			expect(result).toEqual({ ok: true, ip: '10.20.20.50' });
		});

		it('skips addresses already taken', () => {
			const taken = new Set(['10.20.20.50', '10.20.20.51']);
			const result = resolvePeerAddress('10.20.20.0/24', 50, taken);
			expect(result).toEqual({ ok: true, ip: '10.20.20.52' });
		});

		it('never hands out the network address', () => {
			const result = resolvePeerAddress('10.20.20.0/24', 0, new Set());
			expect(result).toEqual({ ok: true, ip: '10.20.20.1' });
		});

		it('never hands out the broadcast address, and reports exhaustion once the range is full', () => {
			// /30 = 4 addresses: .0 (network), .1, .2, .3 (broadcast) - only .1 and .2 are allocatable
			const taken = new Set(['10.20.20.1']);
			const result = resolvePeerAddress('10.20.20.0/30', 0, taken);
			expect(result).toEqual({ ok: true, ip: '10.20.20.2' });

			const exhausted = resolvePeerAddress('10.20.20.0/30', 0, new Set(['10.20.20.1', '10.20.20.2']));
			expect(exhausted).toEqual({ ok: false, failure: { message: 'No more IPs available', field: 'wgAddress' } });
		});

		it('reports exhaustion once reservedIps has consumed the whole range', () => {
			const result = resolvePeerAddress('10.20.20.0/24', 256, new Set());
			expect(result).toEqual({ ok: false, failure: { message: 'No more IPs available', field: 'wgAddress' } });
		});
	});
});

describe('cidrsOverlap', () => {
	it('is true for a containing prefix in either direction', () => {
		expect(cidrsOverlap('192.168.0.0/16', '192.168.1.0/24')).toBe(true);
		expect(cidrsOverlap('192.168.1.0/24', '192.168.0.0/16')).toBe(true);
	});

	it('is true for identical prefixes', () => {
		expect(cidrsOverlap('192.168.1.0/24', '192.168.1.0/24')).toBe(true);
	});

	it('is false for disjoint prefixes, however adjacent', () => {
		expect(cidrsOverlap('192.168.1.0/24', '192.168.2.0/24')).toBe(false);
		expect(cidrsOverlap('10.0.0.0/8', '11.0.0.0/8')).toBe(false);
	});

	it('treats a /0 as overlapping everything', () => {
		expect(cidrsOverlap('0.0.0.0/0', '192.168.1.0/24')).toBe(true);
	});
});

describe('normalizeCidr', () => {
	it('clears host bits, because ip route and nft both reject an unaligned prefix', () => {
		expect(normalizeCidr('192.168.1.5/24')).toBe('192.168.1.0/24');
		expect(normalizeCidr('10.1.2.3/8')).toBe('10.0.0.0/8');
	});

	it('leaves an already-aligned prefix alone', () => {
		expect(normalizeCidr('192.168.1.0/24')).toBe('192.168.1.0/24');
	});
});

describe('advertisedRoutesOf', () => {
	it('decodes the comma-separated column, tolerating whitespace a human typed', () => {
		expect(advertisedRoutesOf({ advertisedRoutes: '192.168.1.0/24, 10.10.0.0/16' })).toEqual(['192.168.1.0/24', '10.10.0.0/16']);
	});

	it('reads null and empty as advertising nothing - the state of every pre-existing peer', () => {
		expect(advertisedRoutesOf({ advertisedRoutes: null })).toEqual([]);
		expect(advertisedRoutesOf({ advertisedRoutes: '' })).toEqual([]);
	});
});

describe('resolveAdvertisedRoutes', () => {
	const SERVER_CIDR = '10.20.20.0/24';

	it('accepts and network-aligns a list', () => {
		expect(resolveAdvertisedRoutes('192.168.1.5/24, 10.10.0.0/16', SERVER_CIDR, [])).toEqual({ ok: true, routes: ['192.168.1.0/24', '10.10.0.0/16'] });
	});

	it('accepts nothing at all', () => {
		expect(resolveAdvertisedRoutes(null, SERVER_CIDR, [])).toEqual({ ok: true, routes: [] });
		expect(resolveAdvertisedRoutes('', SERVER_CIDR, [])).toEqual({ ok: true, routes: [] });
	});

	it('rejects a non-ipv4 or malformed entry', () => {
		expect(resolveAdvertisedRoutes('192.168.1.0', SERVER_CIDR, []).ok).toBe(false);
		expect(resolveAdvertisedRoutes('fd00::/64', SERVER_CIDR, []).ok).toBe(false);
		expect(resolveAdvertisedRoutes('192.168.1.0/33', SERVER_CIDR, []).ok).toBe(false);
	});

	it('rejects a default route, which is the exit-node feature rather than this one', () => {
		const result = resolveAdvertisedRoutes('0.0.0.0/0', SERVER_CIDR, []);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.failure.message).toContain('exit node');
	});

	it("rejects a prefix overlapping the server's own range, which the connected route already owns", () => {
		expect(resolveAdvertisedRoutes('10.20.20.128/25', SERVER_CIDR, []).ok).toBe(false);
		expect(resolveAdvertisedRoutes('10.0.0.0/8', SERVER_CIDR, []).ok).toBe(false);
	});

	it("rejects a prefix that merely *contains* another peer's, not just an exact duplicate", () => {
		// The whole point: wireguard cryptokey routing has one owner per prefix, so a /16 over
		// somebody else's /24 silently steals that traffic instead of failing visibly.
		const taken = [{ label: 'branch-router', routes: ['192.168.1.0/24'] }];

		const result = resolveAdvertisedRoutes('192.168.0.0/16', SERVER_CIDR, taken);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.failure.message).toContain('branch-router');
	});

	it("rejects a prefix contained in another peer's", () => {
		const taken = [{ label: 'branch-router', routes: ['192.168.0.0/16'] }];

		expect(resolveAdvertisedRoutes('192.168.1.0/24', SERVER_CIDR, taken).ok).toBe(false);
	});

	it("accepts a prefix disjoint from every other peer's", () => {
		const taken = [{ label: 'branch-router', routes: ['192.168.1.0/24'] }];

		expect(resolveAdvertisedRoutes('192.168.2.0/24', SERVER_CIDR, taken)).toEqual({ ok: true, routes: ['192.168.2.0/24'] });
	});

	it('rejects a list that overlaps itself', () => {
		const result = resolveAdvertisedRoutes('192.168.0.0/16, 192.168.1.0/24', SERVER_CIDR, []);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.failure.message).toContain('already advertises');
	});
});
