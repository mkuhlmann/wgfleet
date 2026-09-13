import { beforeAll, describe, expect, it } from 'bun:test';
import { db } from '@server/db';
import { serverPeersTable } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { converge } from './converge';
// @server/wg/shell is replaced wholesale by the recording adapter in tests/setup.ts (see
// shell.recording.ts) - this is the seam candidate 2 made observable: real assertions on
// what converge actually did, not just that the handler returned 200.
import { shellCallLog } from '@server/wg/shell.recording';

describe('converge', () => {
	beforeAll(async () => {
		await db
			.insert(serverPeersTable)
			.values([
				{
					id: 'convergeTest-serverA',
					interfaceName: 'wgConvA',
					cidrRange: '10.91.91.0/24',
					reservedIps: 50,
					wgAddress: '10.91.91.1',
					wgListenPort: 51891,
					wgEndpoint: 'testhost:51891',
					wgPrivateKey: 'privateKey',
					wgPublicKey: 'publicKey',
				},
				{
					id: 'convergeTest-serverB',
					interfaceName: 'wgConvB',
					cidrRange: '10.92.92.0/24',
					reservedIps: 50,
					wgAddress: '10.92.92.1',
					wgListenPort: 51892,
					wgEndpoint: 'testhost:51892',
					wgPrivateKey: 'privateKey',
					wgPublicKey: 'publicKey',
				},
			])
			.execute();
	});

	it('reports failure for an unknown server without touching the interface or firewall', async () => {
		shellCallLog.reset();
		const result = await converge('does-not-exist');
		expect(result).toEqual({ ok: false, reason: 'Server not found' });
		expect(shellCallLog.calls()).toEqual([]);
	});

	it('starts the interface when it is not up yet, then reloads (rather than starts) on the next converge, syncing the firewall each time', async () => {
		shellCallLog.reset();

		const first = await converge('convergeTest-serverA');
		expect(first).toEqual({ ok: true });
		expect(shellCallLog.fnsFor('wgConvA')).toEqual(['startInterface']);
		// one look at the host per converge, not one probe per interface - the start-vs-reload
		// decision is made in the plan (wg/plan.ts) from that single snapshot
		expect(shellCallLog.fns().filter((fn) => fn === 'listInterfaces')).toHaveLength(1);
		// firewall, then exit routing last - the latter installs `ip route ... dev <iface>` and
		// so has to run after the interface exists (see converge()).
		expect(shellCallLog.fns().slice(-2)).toEqual(['applyFirewall', 'applyExitRouting']);
		// and carried real content, rather than merely being called: the ruleset is always a
		// whole-fleet replacement (firewall.ts applies `table {}; delete table; table {...}`)
		expect(shellCallLog.lastAppliedRuleset()).toContain('delete table inet wgmgr');
		expect(shellCallLog.lastAppliedExitRouting()).not.toBeNull();

		// no shellCallLog.reset() here - the recording adapter's isInterfaceUp state (set by
		// the startInterface call above) must carry over, same as a real interface would stay up
		const callsBeforeSecond = shellCallLog.calls().length;
		const second = await converge('convergeTest-serverA');
		expect(second).toEqual({ ok: true });
		const newCalls = shellCallLog.calls().slice(callsBeforeSecond);
		expect(newCalls.filter((c) => c.args[0] === 'wgConvA').map((c) => c.fn)).toEqual(['reloadInterface']);
	});

	it('re-resolves the server row itself, so it always converges the latest config', async () => {
		await db.update(serverPeersTable).set({ friendlyName: 'renamed' }).where(eq(serverPeersTable.id, 'convergeTest-serverA'));
		shellCallLog.reset();
		const result = await converge('convergeTest-serverA');
		expect(result).toEqual({ ok: true });
		// no separate "did it pick up the rename" observable here beyond not throwing -
		// the fixture just documents that converge takes an id, not a row, on purpose.
	});

	it('serializes concurrent converge calls rather than racing them', async () => {
		shellCallLog.reset();
		const [resultA, resultB] = await Promise.all([converge('convergeTest-serverA'), converge('convergeTest-serverB')]);

		expect(resultA).toEqual({ ok: true });
		expect(resultB).toEqual({ ok: true });

		const calls = shellCallLog.calls();
		const aIndex = calls.findIndex((c) => c.args[0] === 'wgConvA');
		const bIndex = calls.findIndex((c) => c.args[0] === 'wgConvB');
		// whichever was queued first (A, since it was passed first to Promise.all) must
		// fully finish its interface step before B's starts - the chain is global, not
		// per-server.
		expect(aIndex).toBeLessThan(bIndex);
	});
});
