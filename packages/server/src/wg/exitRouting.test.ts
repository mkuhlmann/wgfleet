import { describe, expect, it } from 'bun:test';
import { buildExitRouting, buildExitRoutingTeardown, type ExitRoutingServer } from './exitRouting';

// Driven entirely against the pure builder - no db, no io. See CLAUDE.md on why test
// scenarios belong on the pure function rather than on syncExitRouting (a single in-memory
// database is shared across every test file, so anything reading "all servers" would pick up
// fixtures from unrelated files).
const server = (overrides: Partial<ExitRoutingServer> = {}): ExitRoutingServer => ({
	interfaceName: 'wg0',
	routeTableId: 52000,
	exitPeerIp: null,
	clientIps: [],
	advertisedRoutes: [],
	...overrides,
});

describe('buildExitRouting', () => {
	it('drains a server with no exit node and leaves its table empty', () => {
		const commands = buildExitRouting([server()]);

		expect(commands.some((c) => c.includes('ip -4 rule del table 52000'))).toBe(true);
		expect(commands.some((c) => c.includes('ip -4 route flush table 52000'))).toBe(true);
		expect(commands.some((c) => c.includes('rule add'))).toBe(false);
	});

	it('installs one default route per interface and one source rule per exit client', () => {
		const commands = buildExitRouting([server({ exitPeerIp: '10.0.0.2', clientIps: ['10.0.0.3', '10.0.0.4'] })]);

		expect(commands).toEqual([
			'ip -4 route flush dev wg0 proto static 2>/dev/null || true',
			'i=0; while [ $i -lt 512 ] && ip -4 rule del table 52000 2>/dev/null; do i=$((i+1)); done',
			'ip -4 route replace default dev wg0 table 52000',
			'ip -4 rule add from 10.0.0.3/32 table 52000',
			'ip -4 rule add from 10.0.0.4/32 table 52000',
		]);
	});

	it('drains before it repopulates, so a full reconcile can never duplicate a rule', () => {
		// `ip rule add` has no upsert - applying twice without the drain would leave two rules
		// for the same client, and removing that client once would leave one behind.
		const commands = buildExitRouting([server({ exitPeerIp: '10.0.0.2', clientIps: ['10.0.0.3'] })]);

		const drainAt = commands.findIndex((c) => c.includes('rule del table 52000'));
		const addAt = commands.findIndex((c) => c.includes('rule add from 10.0.0.3/32'));

		expect(drainAt).toBeGreaterThanOrEqual(0);
		expect(drainAt).toBeLessThan(addAt);
	});

	it('flushes the table of an exit node that has no clients yet, rather than leaving a default route behind', () => {
		const commands = buildExitRouting([server({ exitPeerIp: '10.0.0.2', clientIps: [] })]);

		expect(commands.some((c) => c.includes('route flush table 52000'))).toBe(true);
		expect(commands.some((c) => c.includes('route replace default'))).toBe(false);
	});

	it('uses each server its own table and interface', () => {
		const commands = buildExitRouting([server({ interfaceName: 'wg0', routeTableId: 52000, exitPeerIp: '10.0.0.2', clientIps: ['10.0.0.3'] }), server({ interfaceName: 'wg1', routeTableId: 52001, exitPeerIp: '10.1.0.2', clientIps: ['10.1.0.3'] })]);

		expect(commands).toContain('ip -4 route replace default dev wg0 table 52000');
		expect(commands).toContain('ip -4 rule add from 10.0.0.3/32 table 52000');
		expect(commands).toContain('ip -4 route replace default dev wg1 table 52001');
		expect(commands).toContain('ip -4 rule add from 10.1.0.3/32 table 52001');
	});

	it('emits rules in a stable order regardless of client order, so a no-op sync is a no-op', () => {
		const a = buildExitRouting([server({ exitPeerIp: '10.0.0.2', clientIps: ['10.0.0.9', '10.0.0.3'] })]);
		const b = buildExitRouting([server({ exitPeerIp: '10.0.0.2', clientIps: ['10.0.0.3', '10.0.0.9'] })]);

		expect(a).toEqual(b);
	});

	it('deduplicates a client listed twice', () => {
		const commands = buildExitRouting([server({ exitPeerIp: '10.0.0.2', clientIps: ['10.0.0.3', '10.0.0.3'] })]);

		expect(commands.filter((c) => c.includes('rule add from 10.0.0.3/32'))).toHaveLength(1);
	});

	it('touches no routing table for a server whose routeTableId is outside the allocated band', () => {
		// routeTableId 0 is what an un-backfilled row would carry - flushing table 0 would
		// clobber routing this manager has nothing to do with. The advertised-route half needs
		// no table at all, so it still runs (see the subnet-routes suite below).
		for (const routeTableId of [0, 254, 53000]) {
			const commands = buildExitRouting([server({ routeTableId, exitPeerIp: '10.0.0.2', clientIps: ['10.0.0.3'] })]);

			expect(commands.some((c) => c.includes('table'))).toBe(false);
			expect(commands.some((c) => c.includes('rule'))).toBe(false);
		}
	});

	it('bounds the drain loop so it cannot spin forever', () => {
		const drain = buildExitRouting([server()]).find((c) => c.includes('rule del'));

		expect(drain).toContain('[ $i -lt 512 ]');
	});
});

describe('buildExitRouting - advertised subnet routes', () => {
	it('installs a main-table route per advertised prefix, with no ip rule at all', () => {
		// Destination-based, unlike the exit node's source-based rule: any peer the firewall
		// permits reaches the LAN, so there is no per-client state to install.
		const commands = buildExitRouting([server({ advertisedRoutes: ['192.168.1.0/24'] })]);

		expect(commands).toContain('ip -4 route replace 192.168.1.0/24 dev wg0 proto static');
		expect(commands.some((c) => c.includes('rule add'))).toBe(false);
		expect(commands.some((c) => c.includes('route replace 192.168.1.0/24') && c.includes('table'))).toBe(false);
	});

	it('drains its own proto-static routes before repopulating, so a removed advertisement goes away', () => {
		// The main table cannot be flushed wholesale, so the routes are tagged `proto static`
		// and only that proto is drained - see STATIC_ROUTE_PROTO in exitRouting.ts.
		const commands = buildExitRouting([server({ advertisedRoutes: ['192.168.1.0/24'] })]);

		const drainAt = commands.findIndex((c) => c.includes('route flush dev wg0 proto static'));
		const addAt = commands.findIndex((c) => c.includes('route replace 192.168.1.0/24'));

		expect(drainAt).toBe(0);
		expect(drainAt).toBeLessThan(addAt);
	});

	it('still drains when nothing is advertised, which is how the last advertisement is removed', () => {
		expect(buildExitRouting([server()])).toContain('ip -4 route flush dev wg0 proto static 2>/dev/null || true');
	});

	it('keeps advertised routes even when the routeTableId is outside the allocated band', () => {
		// They need no routing table, so the defensive skip that protects the exit half must
		// not take them down with it.
		const commands = buildExitRouting([server({ routeTableId: 0, advertisedRoutes: ['192.168.1.0/24'] })]);

		expect(commands).toContain('ip -4 route replace 192.168.1.0/24 dev wg0 proto static');
	});

	it('emits routes in a stable, deduplicated order so a no-op sync is a no-op', () => {
		const a = buildExitRouting([server({ advertisedRoutes: ['192.168.9.0/24', '192.168.1.0/24', '192.168.1.0/24'] })]);
		const b = buildExitRouting([server({ advertisedRoutes: ['192.168.1.0/24', '192.168.9.0/24'] })]);

		expect(a).toEqual(b);
		expect(a.filter((c) => c.includes('192.168.1.0/24'))).toHaveLength(1);
	});

	it('composes with an exit node on the same interface', () => {
		const commands = buildExitRouting([server({ exitPeerIp: '10.0.0.2', clientIps: ['10.0.0.3'], advertisedRoutes: ['192.168.1.0/24'] })]);

		expect(commands).toContain('ip -4 route replace 192.168.1.0/24 dev wg0 proto static');
		expect(commands).toContain('ip -4 route replace default dev wg0 table 52000');
		expect(commands).toContain('ip -4 rule add from 10.0.0.3/32 table 52000');
	});

	it('routes each interface its own advertisements', () => {
		const commands = buildExitRouting([server({ interfaceName: 'wg0', advertisedRoutes: ['192.168.1.0/24'] }), server({ interfaceName: 'wg1', routeTableId: 52001, advertisedRoutes: ['192.168.2.0/24'] })]);

		expect(commands).toContain('ip -4 route replace 192.168.1.0/24 dev wg0 proto static');
		expect(commands).toContain('ip -4 route replace 192.168.2.0/24 dev wg1 proto static');
	});
});

describe('buildExitRoutingTeardown', () => {
	it('drains rules and flushes routes for every given table', () => {
		expect(buildExitRoutingTeardown([52000, 52001])).toEqual([
			'i=0; while [ $i -lt 512 ] && ip -4 rule del table 52000 2>/dev/null; do i=$((i+1)); done',
			'ip -4 route flush table 52000 2>/dev/null || true',
			'i=0; while [ $i -lt 512 ] && ip -4 rule del table 52001 2>/dev/null; do i=$((i+1)); done',
			'ip -4 route flush table 52001 2>/dev/null || true',
		]);
	});

	it('ignores table ids outside the allocated band', () => {
		expect(buildExitRoutingTeardown([0, 254, 53000])).toEqual([]);
	});
});
