import { serversPeersRoute } from './serversPeers';
import { db } from '../db';
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { peersTable, policyGrantsTable, serverPeersTable } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { shellCallLog } from '@server/wg/shell.recording';

// Exit-node invariants live in the api layer, not the db (sqlite FK enforcement is never
// turned on here) - checkPeerInvariants in lib/peerInvariants.ts is the only place they hold,
// so this covers it directly, together with the exit-link provisioning converge does off the
// back of them. Fixture ids are prefixed per-file: the whole test run shares one in-memory
// database (see tests/setup.ts).
const SERVER = 'exitNodes-server';
const OTHER = 'exitNodes-otherServer';

describe('exit nodes', () => {
	const app = serversPeersRoute;
	const auth = { authorization: 'Bearer adminToken', 'content-type': 'application/json' };

	const post = (server: string, body: unknown) => app.handle(new Request(`http://localhost/wg/servers/${server}/peers`, { method: 'POST', headers: auth, body: JSON.stringify(body) }));

	const patch = (server: string, peerId: string, body: unknown) => app.handle(new Request(`http://localhost/wg/servers/${server}/peers/${peerId}`, { method: 'PATCH', headers: auth, body: JSON.stringify(body) }));

	beforeAll(async () => {
		await db
			.insert(serverPeersTable)
			.values([
				{
					id: SERVER,
					interfaceName: 'wgExit0',
					cidrRange: '10.66.0.0/24',
					reservedIps: 2,
					wgAddress: '10.66.0.1',
					wgListenPort: 51966,
					wgEndpoint: 'exithost:51966',
					wgPrivateKey: 'privateKey',
					wgPublicKey: 'publicKey',
				},
				{
					id: OTHER,
					interfaceName: 'wgExit1',
					cidrRange: '10.67.0.0/24',
					reservedIps: 2,
					wgAddress: '10.67.0.1',
					wgListenPort: 51967,
					wgEndpoint: 'exithost:51967',
					wgPrivateKey: 'privateKey',
					wgPublicKey: 'publicKey',
				},
			])
			.execute();
	});

	beforeEach(async () => {
		// each test starts from "one exit node, no clients" on SERVER
		await db.delete(policyGrantsTable).where(eq(policyGrantsTable.serverPeerId, SERVER));
		await db.update(peersTable).set({ exitPeerId: null }).where(eq(peersTable.serverPeerId, SERVER));
		await db.delete(peersTable).where(eq(peersTable.serverPeerId, SERVER));
		await db.delete(peersTable).where(eq(peersTable.serverPeerId, OTHER));

		await db
			.insert(peersTable)
			.values([
				{ id: 'exitNodes-exit', serverPeerId: SERVER, wgAddress: '10.66.0.2', wgPrivateKey: 'p', wgPublicKey: 'k', isExitNode: true },
				{ id: 'exitNodes-client', serverPeerId: SERVER, wgAddress: '10.66.0.3', wgPrivateKey: 'p', wgPublicKey: 'k' },
				{ id: 'exitNodes-foreign', serverPeerId: OTHER, wgAddress: '10.67.0.2', wgPrivateKey: 'p', wgPublicKey: 'k', isExitNode: true },
			])
			.execute();
	});

	describe('marking an exit node', () => {
		it('accepts a second exit node on the same server, each on a link of its own', async () => {
			// The constraint is one 0.0.0.0/0 owner per *interface*, and every exit node gets an
			// interface to itself (wg/exitLinks.ts) - so a server can have as many as it likes.
			const response = await patch(SERVER, 'exitNodes-client', { isExitNode: true });
			expect(response.status).toBe(200);

			const peers = await db.query.peersTable.findMany({ where: eq(peersTable.serverPeerId, SERVER) });
			const links = peers.filter((p) => p.isExitNode).map((p) => p.exitInterfaceName);

			expect(links).toHaveLength(2);
			expect(new Set(links).size).toBe(2); // distinct interfaces...
			expect(links.every((name) => name !== null)).toBe(true);
			expect(new Set(peers.filter((p) => p.isExitNode).map((p) => p.exitListenPort)).size).toBe(2); // ...on distinct ports
		});

		it('brings up an interface per exit node, and none of them is the server', async () => {
			shellCallLog.reset();
			await patch(SERVER, 'exitNodes-client', { isExitNode: true });

			const peers = await db.query.peersTable.findMany({ where: eq(peersTable.serverPeerId, SERVER) });
			for (const exitNode of peers.filter((p) => p.isExitNode)) {
				expect(shellCallLog.isUp(exitNode.exitInterfaceName!)).toBe(true);
				// exactly one peer on it - the exit node itself, owning the default route
				expect(shellCallLog.configFor(exitNode.exitInterfaceName!)).toContain('AllowedIPs = 0.0.0.0/0');
			}

			// and the server's own interface carries neither of them any more
			expect(shellCallLog.configFor('wgExit0')).not.toContain('0.0.0.0/0');
		});

		it('releases the link again when the peer stops being an exit node', async () => {
			await patch(SERVER, 'exitNodes-client', { isExitNode: true });
			const provisioned = (await db.query.peersTable.findFirst({ where: eq(peersTable.id, 'exitNodes-client') }))!.exitInterfaceName!;
			expect(shellCallLog.isUp(provisioned)).toBe(true);

			// no reset(): the recording adapter's isInterfaceUp state has to carry over, or
			// converge sees a down interface and skips the teardown it is meant to do here
			const before = shellCallLog.calls().length;
			expect((await patch(SERVER, 'exitNodes-client', { isExitNode: false })).status).toBe(200);

			const after = (await db.query.peersTable.findFirst({ where: eq(peersTable.id, 'exitNodes-client') }))!;
			expect(after.exitInterfaceName).toBeNull();
			expect(after.exitListenPort).toBeNull();
			expect(
				shellCallLog
					.calls()
					.slice(before)
					.filter((c) => c.args[0] === provisioned)
					.map((c) => c.fn),
			).toContain('stopInterface');
			expect(shellCallLog.isUp(provisioned)).toBe(false);
		});

		it('honours an operator-pinned udp port, and refuses one already in use', async () => {
			// The operator has to publish this port, so silently substituting another is worse
			// than refusing.
			expect((await patch(SERVER, 'exitNodes-client', { isExitNode: true, exitListenPort: 51950 })).status).toBe(200);
			expect((await db.query.peersTable.findFirst({ where: eq(peersTable.id, 'exitNodes-client') }))!.exitListenPort).toBe(51950);

			const clash = await post(SERVER, { friendlyName: 'third', isExitNode: true, exitListenPort: 51950 });
			expect(clash.status).toBe(400);
			expect(await clash.text()).toContain('already in use');
		});

		it('allows an exit node on a different interface', async () => {
			const response = await post(OTHER, { friendlyName: 'other-exit', isExitNode: true });

			expect(response.status).toBe(200);
		});

		it('accepts re-marking the peer that is already the exit node (idempotent PATCH)', async () => {
			const response = await patch(SERVER, 'exitNodes-exit', { isExitNode: true });

			expect(response.status).toBe(200);
		});

		it('rejects unmarking an exit node while clients still use it, naming them', async () => {
			await db.update(peersTable).set({ exitPeerId: 'exitNodes-exit' }).where(eq(peersTable.id, 'exitNodes-client'));

			const response = await patch(SERVER, 'exitNodes-exit', { isExitNode: false });

			expect(response.status).toBe(400);
			expect(await response.text()).toContain('10.66.0.3');
		});

		it('allows unmarking once no client uses it', async () => {
			const response = await patch(SERVER, 'exitNodes-exit', { isExitNode: false });

			expect(response.status).toBe(200);
		});
	});

	describe('assigning an exit node', () => {
		it('assigns an exit node and routes that client into its link', async () => {
			shellCallLog.reset();
			const response = await patch(SERVER, 'exitNodes-client', { exitPeerId: 'exitNodes-exit' });

			expect(response.status).toBe(200);

			const exitNode = (await db.query.peersTable.findFirst({ where: eq(peersTable.id, 'exitNodes-exit') }))!;
			expect(shellCallLog.callsFor('wgExit0').length).toBeGreaterThan(0);
			expect(shellCallLog.lastAppliedExitRouting()).toContain(`ip -4 rule add from 10.66.0.3/32 table ${exitNode.exitRouteTableId}`);
			expect(shellCallLog.lastAppliedExitRouting()).toContain(`ip -4 route replace default dev ${exitNode.exitInterfaceName} table ${exitNode.exitRouteTableId}`);
		});

		it('sends two clients of the same server to two different exit nodes', async () => {
			// The whole point of the per-exit-node interface: two ip rules naming two tables,
			// each with a default route out of a different device. One shared interface could not
			// express this at all - the peer within an interface is picked by destination, and
			// both clients want the same destination.
			await patch(SERVER, 'exitNodes-client', { isExitNode: true });

			const clientA = await (await post(SERVER, { friendlyName: 'client-a', exitPeerId: 'exitNodes-exit' })).json();
			const clientB = await (await post(SERVER, { friendlyName: 'client-b', exitPeerId: 'exitNodes-client' })).json();

			const [nodeA, nodeB] = await Promise.all([db.query.peersTable.findFirst({ where: eq(peersTable.id, 'exitNodes-exit') }), db.query.peersTable.findFirst({ where: eq(peersTable.id, 'exitNodes-client') })]);
			const routing = shellCallLog.lastAppliedExitRouting() ?? [];

			expect(nodeA!.exitRouteTableId).not.toBe(nodeB!.exitRouteTableId);
			expect(routing).toContain(`ip -4 rule add from ${clientA.wgAddress}/32 table ${nodeA!.exitRouteTableId}`);
			expect(routing).toContain(`ip -4 rule add from ${clientB.wgAddress}/32 table ${nodeB!.exitRouteTableId}`);
			expect(routing).toContain(`ip -4 route replace default dev ${nodeA!.exitInterfaceName} table ${nodeA!.exitRouteTableId}`);
			expect(routing).toContain(`ip -4 route replace default dev ${nodeB!.exitInterfaceName} table ${nodeB!.exitRouteTableId}`);
		});

		it('installs no ip rule for a peer without an exit node - the rule is the permission', async () => {
			shellCallLog.reset();
			await patch(SERVER, 'exitNodes-client', { friendlyName: 'renamed' });

			// scoped to this server's own table: syncExitRouting reads every server, and the test
			// run shares one in-memory db, so unrelated fixture files contribute their own rules
			const exitNode = (await db.query.peersTable.findFirst({ where: eq(peersTable.id, 'exitNodes-exit') }))!;
			expect(shellCallLog.lastAppliedExitRouting()?.some((c) => c.includes('rule add') && c.includes(`table ${exitNode.exitRouteTableId}`))).toBe(false);
		});

		it('rejects an exit node belonging to another server', async () => {
			const response = await patch(SERVER, 'exitNodes-client', { exitPeerId: 'exitNodes-foreign' });

			expect(response.status).toBe(400);
			expect(await response.text()).toContain('not found on this server');
		});

		it('rejects a peer that is not marked as an exit node', async () => {
			const response = await patch(SERVER, 'exitNodes-exit', { exitPeerId: 'exitNodes-client' });

			expect(response.status).toBe(400);
		});

		it('rejects a peer using itself as its exit node', async () => {
			const response = await patch(SERVER, 'exitNodes-exit', { exitPeerId: 'exitNodes-exit' });

			expect(response.status).toBe(400);
		});

		it('rejects being an exit node and using one at the same time', async () => {
			const response = await patch(SERVER, 'exitNodes-client', { isExitNode: true, exitPeerId: 'exitNodes-exit' });

			expect(response.status).toBe(400);
		});

		it('clears the assignment when exitPeerId is explicitly null', async () => {
			await patch(SERVER, 'exitNodes-client', { exitPeerId: 'exitNodes-exit' });
			const response = await patch(SERVER, 'exitNodes-client', { exitPeerId: null });

			expect(response.status).toBe(200);
			const client = await db.query.peersTable.findFirst({ where: eq(peersTable.id, 'exitNodes-client') });
			expect(client?.exitPeerId).toBeNull();
		});

		it('leaves the assignment untouched when exitPeerId is omitted', async () => {
			await patch(SERVER, 'exitNodes-client', { exitPeerId: 'exitNodes-exit' });
			await patch(SERVER, 'exitNodes-client', { friendlyName: 'renamed' });

			const client = await db.query.peersTable.findFirst({ where: eq(peersTable.id, 'exitNodes-client') });
			expect(client?.exitPeerId).toBe('exitNodes-exit');
		});

		it('accepts an exit node assignment at create time', async () => {
			const response = await post(SERVER, { friendlyName: 'new-client', exitPeerId: 'exitNodes-exit' });

			expect(response.status).toBe(200);
			expect((await response.json()).exitPeerId).toBe('exitNodes-exit');
		});
	});

	describe('deleting an exit node', () => {
		it('unassigns its clients and reports them, rather than silently falling back to the hub', async () => {
			await db.update(peersTable).set({ exitPeerId: 'exitNodes-exit' }).where(eq(peersTable.id, 'exitNodes-client'));

			const response = await app.handle(new Request(`http://localhost/wg/servers/${SERVER}/peers/exitNodes-exit`, { method: 'DELETE', headers: auth }));

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.unassignedExitClients).toHaveLength(1);
			expect(body.unassignedExitClients[0].wgAddress).toBe('10.66.0.3');

			const client = await db.query.peersTable.findFirst({ where: eq(peersTable.id, 'exitNodes-client') });
			expect(client?.exitPeerId).toBeNull();
		});
	});

	describe('config renderings', () => {
		it('serves both variants from the same peer row, differing only in AllowedIPs', async () => {
			await patch(SERVER, 'exitNodes-client', { exitPeerId: 'exitNodes-exit' });

			const normal = await app.handle(new Request(`http://localhost/wg/servers/${SERVER}/peers/exitNodes-client/config`, { headers: auth }));
			const exit = await app.handle(new Request(`http://localhost/wg/servers/${SERVER}/peers/exitNodes-client/config?exit=true`, { headers: auth }));

			const normalText = await normal.text();
			const exitText = await exit.text();

			expect(normalText).toContain('AllowedIPs = 10.66.0.0/24');
			expect(exitText).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
			expect(exitText).toContain('Address = 10.66.0.3/32');
			expect(normalText).toContain('Address = 10.66.0.3/32');
		});

		it('serves the exit node its own config with the gateway NAT block on request', async () => {
			const response = await app.handle(new Request(`http://localhost/wg/servers/${SERVER}/peers/exitNodes-exit/config?nat=true`, { headers: auth }));

			expect(await response.text()).toContain('MASQUERADE');
		});
	});
});
