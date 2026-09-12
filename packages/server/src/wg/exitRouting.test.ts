import { describe, expect, it } from 'bun:test';
import { buildExitRouting, buildExitRoutingTeardown, type ExitRoutingLink, type ExitRoutingServer } from './exitRouting';

// Driven entirely against the pure builder - no db, no io. See CLAUDE.md on why test
// scenarios belong on the pure function rather than on syncExitRouting (a single in-memory
// database is shared across every test file, so anything reading "all servers" would pick up
// fixtures from unrelated files).
const link = (overrides: Partial<ExitRoutingLink> = {}): ExitRoutingLink => ({
	interfaceName: 'wgx0',
	staticRoutes: ['10.0.0.2/32'],
	routeTableId: 52000,
	clientIps: ['10.0.0.3'],
	...overrides,
});

const server = (overrides: Partial<ExitRoutingServer> = {}): ExitRoutingServer => ({
	interfaceName: 'wg0',
	cidrRange: '10.0.0.0/24',
	staticRoutes: [],
	exitLinks: [],
	...overrides,
});

describe('buildExitRouting', () => {
	it('drains an exit link with no clients and leaves its table empty', () => {
		const commands = buildExitRouting([server({ exitLinks: [link({ clientIps: [] })] })]);

		expect(commands.some((c) => c.includes('ip -4 rule del table 52000'))).toBe(true);
		expect(commands.some((c) => c.includes('ip -4 route flush table 52000'))).toBe(true);
		expect(commands.some((c) => c.includes('rule add'))).toBe(false);
	});

	it('builds a complete table per exit node, not just a default route', () => {
		// An exit client's ip rule captures *all* of its traffic, so a table holding only the
		// default route would give it the internet and take away every one of its peers.
		const commands = buildExitRouting([server({ exitLinks: [link({ clientIps: ['10.0.0.3', '10.0.0.4'] })] })]);

		expect(commands).toEqual([
			'ip -4 route flush dev wg0 proto static 2>/dev/null || true',
			'ip -4 route flush dev wgx0 proto static 2>/dev/null || true',
			// the exit node left its server's interface, so its connected route no longer covers it
			'ip -4 route replace 10.0.0.2/32 dev wgx0 proto static',
			'i=0; while [ $i -lt 512 ] && ip -4 rule del table 52000 2>/dev/null; do i=$((i+1)); done',
			// the vpn subnet stays reachable through the server's own interface...
			'ip -4 route replace 10.0.0.0/24 dev wg0 table 52000',
			// ...and the exit node itself through its link, more specifically
			'ip -4 route replace 10.0.0.2/32 dev wgx0 table 52000',
			'ip -4 route replace default dev wgx0 table 52000',
			'ip -4 rule add from 10.0.0.3/32 table 52000',
			'ip -4 rule add from 10.0.0.4/32 table 52000',
		]);
	});

	it('gives each exit node its own table and its own interface - this is what multiple exit nodes are', () => {
		// Two clients of one server landing in different tables, each with a default route out
		// of a different device. One shared interface could not express this at all: the peer
		// within an interface is chosen by destination, and both clients want the whole internet.
		const commands = buildExitRouting([
			server({
				exitLinks: [link({ interfaceName: 'wgx0', staticRoutes: ['10.0.0.2/32'], routeTableId: 52000, clientIps: ['10.0.0.3'] }), link({ interfaceName: 'wgx1', staticRoutes: ['10.0.0.4/32'], routeTableId: 52001, clientIps: ['10.0.0.5'] })],
			}),
		]);

		expect(commands).toContain('ip -4 route replace default dev wgx0 table 52000');
		expect(commands).toContain('ip -4 rule add from 10.0.0.3/32 table 52000');
		expect(commands).toContain('ip -4 route replace default dev wgx1 table 52001');
		expect(commands).toContain('ip -4 rule add from 10.0.0.5/32 table 52001');
	});

	it('lets a client of one exit node still reach the other exit node as an ordinary peer', () => {
		// Both /32s go into both tables, so the split across interfaces is invisible to peers.
		const commands = buildExitRouting([
			server({
				exitLinks: [link({ interfaceName: 'wgx0', staticRoutes: ['10.0.0.2/32'], routeTableId: 52000, clientIps: ['10.0.0.3'] }), link({ interfaceName: 'wgx1', staticRoutes: ['10.0.0.4/32'], routeTableId: 52001, clientIps: ['10.0.0.5'] })],
			}),
		]);

		expect(commands).toContain('ip -4 route replace 10.0.0.4/32 dev wgx1 table 52000');
		expect(commands).toContain('ip -4 route replace 10.0.0.2/32 dev wgx0 table 52001');
	});

	it('drains before it repopulates, so a full reconcile can never duplicate a rule', () => {
		// `ip rule add` has no upsert - applying twice without the drain would leave two rules
		// for the same client, and removing that client once would leave one behind.
		const commands = buildExitRouting([server({ exitLinks: [link()] })]);

		const drainAt = commands.findIndex((c) => c.includes('rule del table 52000'));
		const addAt = commands.findIndex((c) => c.includes('rule add from 10.0.0.3/32'));

		expect(drainAt).toBeGreaterThanOrEqual(0);
		expect(drainAt).toBeLessThan(addAt);
	});

	it('flushes the table of an exit node that has no clients yet, rather than leaving a default route behind', () => {
		const commands = buildExitRouting([server({ exitLinks: [link({ clientIps: [] })] })]);

		expect(commands.some((c) => c.includes('route flush table 52000'))).toBe(true);
		expect(commands.some((c) => c.includes('route replace default'))).toBe(false);
	});

	it('emits rules in a stable order regardless of client order, so a no-op sync is a no-op', () => {
		const a = buildExitRouting([server({ exitLinks: [link({ clientIps: ['10.0.0.9', '10.0.0.3'] })] })]);
		const b = buildExitRouting([server({ exitLinks: [link({ clientIps: ['10.0.0.3', '10.0.0.9'] })] })]);

		expect(a).toEqual(b);
	});

	it('deduplicates a client listed twice', () => {
		const commands = buildExitRouting([server({ exitLinks: [link({ clientIps: ['10.0.0.3', '10.0.0.3'] })] })]);

		expect(commands.filter((c) => c.includes('rule add from 10.0.0.3/32'))).toHaveLength(1);
	});

	it('touches no routing table when the id is outside the allocated band', () => {
		// table 0 is what a directly written row would carry - flushing it would clobber routing
		// this manager has nothing to do with. The main-table routes need no table, so they run.
		for (const routeTableId of [0, 254, 53000]) {
			const commands = buildExitRouting([server({ exitLinks: [link({ routeTableId })] })]);

			expect(commands.some((c) => c.includes('table'))).toBe(false);
			expect(commands.some((c) => c.includes('rule'))).toBe(false);
			expect(commands).toContain('ip -4 route replace 10.0.0.2/32 dev wgx0 proto static');
		}
	});

	it('bounds the drain loop so it cannot spin forever', () => {
		const drain = buildExitRouting([server({ exitLinks: [link()] })]).find((c) => c.includes('rule del'));

		expect(drain).toContain('[ $i -lt 512 ]');
	});
});

describe('buildExitRouting - advertised subnet routes', () => {
	it('installs a main-table route per advertised prefix, with no ip rule at all', () => {
		// Destination-based, unlike the exit node's source-based rule: any peer the firewall
		// permits reaches the LAN, so there is no per-client state to install.
		const commands = buildExitRouting([server({ staticRoutes: ['192.168.1.0/24'] })]);

		expect(commands).toContain('ip -4 route replace 192.168.1.0/24 dev wg0 proto static');
		expect(commands.some((c) => c.includes('rule add'))).toBe(false);
		expect(commands.some((c) => c.includes('table'))).toBe(false);
	});

	it('drains its own proto-static routes before repopulating, so a removed advertisement goes away', () => {
		// The main table cannot be flushed wholesale, so the routes are tagged `proto static`
		// and only that proto is drained - see STATIC_ROUTE_PROTO in exitRouting.ts.
		const commands = buildExitRouting([server({ staticRoutes: ['192.168.1.0/24'] })]);

		const drainAt = commands.findIndex((c) => c.includes('route flush dev wg0 proto static'));
		const addAt = commands.findIndex((c) => c.includes('route replace 192.168.1.0/24'));

		expect(drainAt).toBe(0);
		expect(drainAt).toBeLessThan(addAt);
	});

	it('still drains when nothing is advertised, which is how the last advertisement is removed', () => {
		expect(buildExitRouting([server()])).toContain('ip -4 route flush dev wg0 proto static 2>/dev/null || true');
	});

	it('emits routes in a stable, deduplicated order so a no-op sync is a no-op', () => {
		const a = buildExitRouting([server({ staticRoutes: ['192.168.9.0/24', '192.168.1.0/24', '192.168.1.0/24'] })]);
		const b = buildExitRouting([server({ staticRoutes: ['192.168.1.0/24', '192.168.9.0/24'] })]);

		expect(a).toEqual(b);
		expect(a.filter((c) => c.includes('192.168.1.0/24'))).toHaveLength(1);
	});

	it("reaches an advertised LAN from inside an exit client's table too", () => {
		// Otherwise assigning an exit node would silently revoke a client's access to every
		// advertised subnet, since its rule captures all of its traffic.
		const commands = buildExitRouting([server({ staticRoutes: ['192.168.1.0/24'], exitLinks: [link()] })]);

		expect(commands).toContain('ip -4 route replace 192.168.1.0/24 dev wg0 proto static');
		expect(commands).toContain('ip -4 route replace 192.168.1.0/24 dev wg0 table 52000');
	});

	it("puts an exit node's own advertisements on its link, alongside its reachability route", () => {
		// An exit node that also advertises a LAN is one peer on one interface - both kinds of
		// route therefore belong on that interface, not on the server's.
		const commands = buildExitRouting([server({ exitLinks: [link({ staticRoutes: ['10.0.0.2/32', '192.168.1.0/24'] })] })]);

		expect(commands).toContain('ip -4 route replace 192.168.1.0/24 dev wgx0 proto static');
		expect(commands).toContain('ip -4 route replace 10.0.0.2/32 dev wgx0 proto static');
		expect(commands).toContain('ip -4 route replace default dev wgx0 table 52000');
	});

	it('routes each server its own advertisements', () => {
		const commands = buildExitRouting([server({ interfaceName: 'wg0', staticRoutes: ['192.168.1.0/24'] }), server({ interfaceName: 'wg1', staticRoutes: ['192.168.2.0/24'] })]);

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
