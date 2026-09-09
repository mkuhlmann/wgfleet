import { describe, expect, it } from 'bun:test';
import { resolvePeerAddress } from './addressing';

describe('resolvePeerAddress', () => {
	describe('requested address', () => {
		it('accepts a requested address inside the range and not taken', () => {
			const result = resolvePeerAddress('10.20.20.0/24', 50, new Set(), { requested: '10.20.20.5' });
			expect(result).toEqual({ ok: true, ip: '10.20.20.5' });
		});

		it('rejects a requested address outside the CIDR range', () => {
			const result = resolvePeerAddress('10.20.20.0/24', 50, new Set(), { requested: '10.20.21.5' });
			expect(result).toEqual({ ok: false, message: 'wgAddress is not in CIDR range' });
		});

		it('rejects a requested address already in use', () => {
			const result = resolvePeerAddress('10.20.20.0/24', 50, new Set(['10.20.20.5']), { requested: '10.20.20.5' });
			expect(result).toEqual({ ok: false, message: 'IP already in use' });
		});

		it('rejects an IPv6 address against an IPv4 CIDR rather than misinterpreting it', () => {
			const result = resolvePeerAddress('10.20.20.0/24', 50, new Set(), { requested: '2001:db8::1' });
			expect(result).toEqual({ ok: false, message: 'wgAddress is not in CIDR range' });
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
			expect(exhausted).toEqual({ ok: false, message: 'No more IPs available' });
		});

		it('reports exhaustion once reservedIps has consumed the whole range', () => {
			const result = resolvePeerAddress('10.20.20.0/24', 256, new Set());
			expect(result).toEqual({ ok: false, message: 'No more IPs available' });
		});
	});
});
