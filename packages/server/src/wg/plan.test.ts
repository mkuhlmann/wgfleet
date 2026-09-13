import { describe, expect, it } from 'bun:test';
import { planConverge, type ConvergeInput } from './plan';
import { graphOf, type PeerSpec } from '@server/tests/graphs';
import type { ExitLinkReconcile } from './exitLinks';

// Everything converge decides, decided without a host: the fleet snapshot and the list of
// interfaces currently up are the only inputs, so start-vs-reload, the orphan sweep and the
// ordering between them are all fixtures here rather than prose in converge.ts.
const NOTHING: ExitLinkReconcile = { releasedInterfaces: [], releasedRouteTableIds: [], provisionedInterfaces: [], failures: [] };

const exitNode = (spec: { id?: string; ip?: string; interfaceName?: string; routeTableId?: number } = {}): PeerSpec => ({
	id: spec.id ?? 'n0',
	ip: spec.ip ?? '10.0.0.2',
	isExitNode: true,
	link: { interfaceName: spec.interfaceName ?? 'wgx0', listenPort: 51900, routeTableId: spec.routeTableId ?? 52000 },
});

const plan = (input: Partial<ConvergeInput> & { upInterfaces?: string[] } = {}) =>
	planConverge({
		serverId: 's0',
		fleet: input.fleet ?? [graphOf({ id: 's0', interfaceName: 'wg0', cidrRange: '10.0.0.0/24', wgAddress: '10.0.0.1' })],
		upInterfaces: input.upInterfaces ?? [],
		reconcile: input.reconcile ?? NOTHING,
		...input,
	});

/** The interface steps as `action interfaceName` pairs - the part of the plan that is ordered. */
const steps = (p: ReturnType<typeof plan>) => p.interfaces.map((s) => `${s.action} ${s.interfaceName}`);

describe('planConverge', () => {
	it('starts an interface that is not up and reloads one that is', () => {
		expect(steps(plan())).toEqual(['start wg0']);
		expect(steps(plan({ upInterfaces: ['wg0'] }))).toEqual(['reload wg0']);
	});

	it("plans a step for the server's own interface and one per provisioned exit link", () => {
		const fleet = [graphOf({ id: 's0', interfaceName: 'wg0', peers: [exitNode({ id: 'n0', interfaceName: 'wgx0' }), exitNode({ id: 'n1', ip: '10.0.0.4', interfaceName: 'wgx1', routeTableId: 52001 })] })];

		expect(steps(plan({ fleet }))).toEqual(['start wg0', 'start wgx0', 'start wgx1']);
	});

	it('skips an exit node whose link is not provisioned yet', () => {
		const fleet = [graphOf({ id: 's0', interfaceName: 'wg0', peers: [{ id: 'n0', ip: '10.0.0.2', isExitNode: true, link: null }] })];

		expect(steps(plan({ fleet }))).toEqual(['start wg0']);
	});

	it('takes released links down before anything comes up, so their name and port are reusable', () => {
		const reconcile: ExitLinkReconcile = { ...NOTHING, releasedInterfaces: ['wgx3'], releasedRouteTableIds: [52003] };
		const p = plan({ upInterfaces: ['wgx3'], reconcile });

		expect(steps(p)).toEqual(['stop wgx3', 'start wg0']);
		expect(p.drainRouteTableIds).toEqual([52003]);
	});

	it('does not plan a stop for a released link that is not up', () => {
		expect(steps(plan({ reconcile: { ...NOTHING, releasedInterfaces: ['wgx3'] } }))).toEqual(['start wg0']);
	});

	describe('orphaned exit links', () => {
		it('stops a wgx interface no peer claims any more', () => {
			const p = plan({ upInterfaces: ['wg0', 'wgx7'] });

			expect(steps(p)).toEqual(['stop wgx7', 'reload wg0']);
			expect(p.interfaces[0]).toMatchObject({ action: 'stop', reason: 'orphaned' });
		});

		it('never touches a non-wgx interface, whoever owns it', () => {
			// somebody else's wireguard interface on the same host
			expect(steps(plan({ upInterfaces: ['wg0', 'wg-personal'] }))).toEqual(['reload wg0']);
		});

		it('leaves a claimed link alone, including one belonging to another server', () => {
			const fleet = [graphOf({ id: 's0', interfaceName: 'wg0' }), graphOf({ id: 's1', interfaceName: 'wg1', cidrRange: '10.1.0.0/24', peers: [exitNode({ id: 'other', interfaceName: 'wgx9' })] })];

			expect(steps(plan({ fleet, upInterfaces: ['wgx9'] }))).toEqual(['start wg0']);
		});

		it('restarts - never reloads - a link whose name was just re-handed out while still up', () => {
			// The hazard this exists for: wgx0 survives a crash, the db no longer describes it,
			// so allocateExitLink hands the name straight back to a new exit node. `wg syncconf`
			// applies the peers but not the `[Interface]` half, so a reload would leave the new
			// node running the dead one's private key and udp port - healthy-looking, reachable
			// by nobody.
			const fleet = [graphOf({ id: 's0', interfaceName: 'wg0', peers: [exitNode({ interfaceName: 'wgx0' })] })];
			const reconcile: ExitLinkReconcile = { ...NOTHING, provisionedInterfaces: ['wgx0'] };

			expect(steps(plan({ fleet, upInterfaces: ['wg0', 'wgx0'], reconcile }))).toEqual(['reload wg0', 'restart wgx0']);
		});

		it('reloads a link that is up and was not reprovisioned', () => {
			const fleet = [graphOf({ id: 's0', interfaceName: 'wg0', peers: [exitNode({ interfaceName: 'wgx0' })] })];

			expect(steps(plan({ fleet, upInterfaces: ['wg0', 'wgx0'] }))).toEqual(['reload wg0', 'reload wgx0']);
		});

		it('starts - not reloads - an interface it just planned to stop', () => {
			// a released link whose name came straight back to a new exit node in the same plan
			const fleet = [graphOf({ id: 's0', interfaceName: 'wg0', peers: [exitNode({ interfaceName: 'wgx0' })] })];
			const reconcile: ExitLinkReconcile = { ...NOTHING, releasedInterfaces: ['wgx0'], provisionedInterfaces: ['wgx0'] };

			expect(steps(plan({ fleet, upInterfaces: ['wg0', 'wgx0'], reconcile }))).toEqual(['stop wgx0', 'reload wg0', 'start wgx0']);
		});
	});

	describe('the host-wide half', () => {
		it('is built from the whole fleet, not just the converging server', () => {
			const fleet = [graphOf({ id: 's0', interfaceName: 'wg0', cidrRange: '10.0.0.0/24' }), graphOf({ id: 's1', interfaceName: 'wg1', cidrRange: '10.1.0.0/24', peers: [{ id: 'adv', ip: '10.1.0.5', advertisedRoutes: '192.168.1.0/24' }] })];
			const p = plan({ fleet });

			expect(p.routing).toContain('ip -4 route replace 192.168.1.0/24 dev wg1 proto static');
			expect(p.ruleset).toContain('delete table inet wgmgr');
		});

		it('is still planned in full for a server that no longer exists in the snapshot', () => {
			// deleted concurrently with the mutation that triggered this converge - the ruleset
			// and routing still have to be rebuilt without it
			const p = planConverge({ serverId: 'gone', fleet: [graphOf({ id: 's0', interfaceName: 'wg0' })], upInterfaces: [], reconcile: NOTHING });

			expect(p.interfaces).toEqual([]);
			expect(p.ruleset).toContain('table inet wgmgr');
		});
	});
});
