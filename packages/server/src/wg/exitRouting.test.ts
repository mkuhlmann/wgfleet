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

	it('skips a server whose routeTableId is outside the allocated band rather than touching a table it does not own', () => {
		// routeTableId 0 is what an un-backfilled row would carry - flushing table 0 would
		// clobber routing this manager has nothing to do with.
		expect(buildExitRouting([server({ routeTableId: 0, exitPeerIp: '10.0.0.2', clientIps: ['10.0.0.3'] })])).toEqual([]);
		expect(buildExitRouting([server({ routeTableId: 254, exitPeerIp: '10.0.0.2', clientIps: ['10.0.0.3'] })])).toEqual([]);
		expect(buildExitRouting([server({ routeTableId: 53000, exitPeerIp: '10.0.0.2', clientIps: ['10.0.0.3'] })])).toEqual([]);
	});

	it('bounds the drain loop so it cannot spin forever', () => {
		const [drain] = buildExitRouting([server()]);

		expect(drain).toContain('[ $i -lt 512 ]');
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
