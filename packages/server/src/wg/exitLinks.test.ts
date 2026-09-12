import { describe, expect, it } from 'bun:test';
import { allocateExitLink, isExitLinkInterface, EXIT_LISTEN_PORT_MIN, EXIT_ROUTE_TABLE_MIN, type ExitLinkTaken } from './exitLinks';

// Driven against the pure allocator - no db, no io. The reconcile half is covered end to end
// through the api in api/exitNodes.test.ts, where the interesting behaviour (provision on
// converge, release on unmark) actually shows up.
const taken = (overrides: Partial<ExitLinkTaken> = {}): ExitLinkTaken => ({
	interfaceNames: new Set<string>(),
	listenPorts: new Set<number>(),
	routeTableIds: new Set<number>(),
	...overrides,
});

describe('allocateExitLink', () => {
	it('hands out the lowest free name, port and table', () => {
		const result = allocateExitLink(taken());

		expect(result).toEqual({ ok: true, allocation: { interfaceName: 'wgx0', listenPort: EXIT_LISTEN_PORT_MIN, routeTableId: EXIT_ROUTE_TABLE_MIN } });
	});

	it('skips what is already in use, so two exit nodes never share an interface or a port', () => {
		// Sharing either one is exactly the failure this whole design exists to avoid: two
		// peers on one interface means one of them silently loses 0.0.0.0/0.
		const result = allocateExitLink(
			taken({
				interfaceNames: new Set(['wg0', 'wgx0', 'wgx1']),
				listenPorts: new Set([51820, EXIT_LISTEN_PORT_MIN]),
				routeTableIds: new Set([EXIT_ROUTE_TABLE_MIN]),
			}),
		);

		expect(result).toEqual({ ok: true, allocation: { interfaceName: 'wgx2', listenPort: EXIT_LISTEN_PORT_MIN + 1, routeTableId: EXIT_ROUTE_TABLE_MIN + 1 } });
	});

	it('reuses a gap left by a released link rather than growing forever', () => {
		const result = allocateExitLink(taken({ interfaceNames: new Set(['wgx0', 'wgx2']) }));

		expect(result.ok && result.allocation.interfaceName).toBe('wgx1');
	});

	it('never picks a name a server already uses, even a wgx-shaped one', () => {
		// The ordinal scan only looks at wgx-shaped names, so a server called wgx0 would
		// otherwise be shadowed by a link that silently takes its place.
		const result = allocateExitLink(taken({ interfaceNames: new Set(['wgx0']) }));

		expect(result.ok && result.allocation.interfaceName).toBe('wgx1');
	});

	it('honours a pinned port', () => {
		const result = allocateExitLink(taken(), 51820);

		expect(result.ok && result.allocation.listenPort).toBe(51820);
	});

	it('refuses a pinned port that is taken rather than silently substituting another', () => {
		// The operator has to publish this port in docker or a host firewall - getting a
		// different one back than the one they asked for is worse than an error.
		const result = allocateExitLink(taken({ listenPorts: new Set([51820]) }), 51820);

		expect(result).toEqual({ ok: false, message: 'Port 51820 is already in use by another interface' });
	});

	it('reports which resource ran out instead of allocating a partial link', () => {
		const ports = new Set<number>();
		for (let port = 51900; port <= 51999; port++) ports.add(port);

		const result = allocateExitLink(taken({ listenPorts: ports }));

		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toContain('No free udp port');
	});
});

describe('isExitLinkInterface', () => {
	it('matches only the names this module allocates', () => {
		expect(isExitLinkInterface('wgx0')).toBe(true);
		expect(isExitLinkInterface('wgx42')).toBe(true);
		// converge deletes unclaimed matches, so anything else must not match
		expect(isExitLinkInterface('wg0')).toBe(false);
		expect(isExitLinkInterface('wgx')).toBe(false);
		expect(isExitLinkInterface('wgxhome')).toBe(false);
		expect(isExitLinkInterface('mywgx0')).toBe(false);
	});
});
