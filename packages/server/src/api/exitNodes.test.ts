import { serversPeersRoute } from './serversPeers';
import { db } from '../db';
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { peersTable, policyGrantsTable, serverPeersTable } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { shellCallLog } from '@server/wg/shell';

// Exit-node invariants live in the api layer, not the db (sqlite FK enforcement is never
// turned on here) - assertExitNodeInvariants in api/serversPeers.ts is the only place they
// hold, so this covers it directly. Fixture ids are prefixed per-file: the whole test run
// shares one in-memory database (see tests/setup.ts).
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
					routeTableId: 52800,
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
					routeTableId: 52801,
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
		it('rejects a second exit node on the same interface', async () => {
			// hard wireguard constraint, not a policy choice: only one peer per interface can
			// own AllowedIPs 0.0.0.0/0
			const response = await patch(SERVER, 'exitNodes-client', { isExitNode: true });

			expect(response.status).toBe(400);
			expect(await response.text()).toContain('already has an exit node');
		});

		it('allows an exit node on a different interface', async () => {
			const response = await post(OTHER, { friendlyName: 'other-exit', isExitNode: true });

			// wgExit1's own exit node is exitNodes-foreign, so this is the second there too
			expect(response.status).toBe(400);
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
		it('assigns an exit node and converges the interface', async () => {
			shellCallLog.reset();
			const response = await patch(SERVER, 'exitNodes-client', { exitPeerId: 'exitNodes-exit' });

			expect(response.status).toBe(200);

			// the assignment changes the interface config (Table = off, the exit node's
			// AllowedIPs) as well as routing, so it must converge, not just sync policy
			expect(shellCallLog.callsFor('wgExit0').length).toBeGreaterThan(0);
			expect(shellCallLog.lastAppliedExitRouting()).toContain('ip -4 rule add from 10.66.0.3/32 table 52800');
			expect(shellCallLog.lastAppliedExitRouting()).toContain('ip -4 route replace default dev wgExit0 table 52800');
		});

		it('installs no ip rule for a peer without an exit node - the rule is the permission', async () => {
			shellCallLog.reset();
			await patch(SERVER, 'exitNodes-client', { friendlyName: 'renamed' });

			// scoped to this server's own table: syncExitRouting reads every server, and the test
			// run shares one in-memory db, so unrelated fixture files contribute their own rules
			expect(shellCallLog.lastAppliedExitRouting()?.some((c) => c.includes('rule add') && c.includes('table 52800'))).toBe(false);
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

		it('rejects an exit node assignment when the peer already has internet via the hub', async () => {
			// routing wins over the grant, so the grant would be silently inert - reject rather
			// than let the db hold a state the ui's three-way selector cannot display
			await db.insert(policyGrantsTable).values({
				serverPeerId: SERVER,
				position: 0,
				action: 'allow',
				srcKind: 'peer',
				srcPeerId: 'exitNodes-client',
				dstKind: 'internet',
			});

			const response = await patch(SERVER, 'exitNodes-client', { exitPeerId: 'exitNodes-exit' });

			expect(response.status).toBe(400);
			expect(await response.text()).toContain('internet');
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
