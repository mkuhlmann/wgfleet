import { serversPeersRoute } from './serversPeers';
import { db } from '../db';
import { beforeAll, describe, expect, it } from 'bun:test';
import { peerTagsTable, serverPeersTable } from '@server/db/schema';
import { shellCallLog } from '@server/wg/shell.recording';

describe('serversPeersRoute', () => {
	beforeAll(async () => {
		await db
			.insert(serverPeersTable)
			.values({
				id: 'serversPeersRoute-server',
				interfaceName: 'wg7',
				cidrRange: '10.77.77.0/24',
				reservedIps: 10,
				wgAddress: '10.77.77.1',
				wgListenPort: 51877,
				wgEndpoint: 'testhost:51877',
				wgPrivateKey: 'privateKey',
				wgPublicKey: 'publicKey',
				authToken: 'serversPeersRoute-token',
			})
			.execute();

		await db.insert(peerTagsTable).values({ id: 'serversPeersRoute-tag', serverPeerId: 'serversPeersRoute-server', name: 'office' }).execute();
	});

	const app = serversPeersRoute;
	const auth = { authorization: 'Bearer serversPeersRoute-token' };

	describe('POST /wg/servers/:id/peers', () => {
		it('creates a peer, addressable by the server interfaceName in the url', async () => {
			shellCallLog.reset();
			const response = await app.handle(
				new Request('http://localhost/wg/servers/wg7/peers', {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ friendlyName: 'laptop', tagIds: ['serversPeersRoute-tag'] }),
				}),
			);
			expect(response.status).toBe(200);
			const peer = await response.json();
			expect(peer.friendlyName).toBe('laptop');
			expect(peer.tagIds).toEqual(['serversPeersRoute-tag']);
			expect(peer.wgAddress).toBe('10.77.77.10'); // first free after reservedIps=10

			// converge is awaited by the handler - by the time the response resolved, the
			// interface was brought up and the firewall re-synced (candidate 1/2: this used
			// to be a fire-and-forget call the test suite couldn't observe at all).
			expect(shellCallLog.callsFor('wg7').length).toBeGreaterThan(0);
			expect(shellCallLog.lastAppliedRuleset()).toContain('wg7');
		});

		it('rejects a tag that does not belong to this server', async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/wg7/peers', {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ tagIds: ['does-not-exist'] }),
				}),
			);
			expect(response.status).toBe(400);
		});

		it('returns 404 for an unknown server (admin token, since a server-scoped token cannot authenticate against a nonexistent server at all)', async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/does-not-exist/peers', {
					method: 'POST',
					headers: { authorization: 'Bearer adminToken', 'content-type': 'application/json' },
					body: JSON.stringify({}),
				}),
			);
			expect(response.status).toBe(404);
		});
	});

	describe('GET /wg/servers/:id/peers', () => {
		it('lists peers scoped to the server, with tagIds', async () => {
			const response = await app.handle(new Request('http://localhost/wg/servers/serversPeersRoute-server/peers', { headers: auth }));
			expect(response.status).toBe(200);
			const peers = await response.json();
			expect(peers.length).toBe(1);
			expect(peers[0].tagIds).toEqual(['serversPeersRoute-tag']);
		});
	});

	describe('PATCH /wg/servers/:id/peers/:peerId', () => {
		it('updates a peer addressed via the server id, scoping the peer lookup correctly', async () => {
			const [peer] = await db.query.peersTable.findMany({ where: (t, { eq }) => eq(t.serverPeerId, 'serversPeersRoute-server') });

			const response = await app.handle(
				new Request(`http://localhost/wg/servers/serversPeersRoute-server/peers/${peer.id}`, {
					method: 'PATCH',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ friendlyName: 'renamed' }),
				}),
			);
			expect(response.status).toBe(200);
			const [updated] = await response.json();
			expect(updated.friendlyName).toBe('renamed');
		});

		it('returns 404 for a peer id that belongs to a different server', async () => {
			await db
				.insert(serverPeersTable)
				.values({
					id: 'serversPeersRoute-otherServer',
					interfaceName: 'wg7b',
					cidrRange: '10.78.78.0/24',
					reservedIps: 10,
					wgAddress: '10.78.78.1',
					wgListenPort: 51878,
					wgEndpoint: 'testhost:51878',
					wgPrivateKey: 'privateKey',
					wgPublicKey: 'publicKey',
					authToken: 'serversPeersRoute-otherToken',
				})
				.execute();

			const [peer] = await db.query.peersTable.findMany({ where: (t, { eq }) => eq(t.serverPeerId, 'serversPeersRoute-server') });

			const response = await app.handle(
				new Request(`http://localhost/wg/servers/serversPeersRoute-otherServer/peers/${peer.id}`, {
					method: 'PATCH',
					headers: { authorization: 'Bearer serversPeersRoute-otherToken', 'content-type': 'application/json' },
					body: JSON.stringify({ friendlyName: 'should not apply' }),
				}),
			);
			expect(response.status).toBe(404);
		});
	});

	describe('GET /wg/servers/:id/peers/:peerId/config', () => {
		it('resolves the server by interfaceName too (not just id)', async () => {
			const [peer] = await db.query.peersTable.findMany({ where: (t, { eq }) => eq(t.serverPeerId, 'serversPeersRoute-server') });

			const response = await app.handle(new Request(`http://localhost/wg/servers/wg7/peers/${peer.id}/config`, { headers: auth }));
			expect(response.status).toBe(200);
			expect(await response.text()).toContain('[Interface]');
		});
	});

	describe('address allocation', () => {
		// The interface's own address is not a peer, so nothing in the peers table reserves it
		// - and reservedIps is a convention, not a constraint. Both peers below would otherwise
		// be handed 10.79.79.1, the hub's own ip.
		const narrowAuth = { authorization: 'Bearer serversPeersRoute-narrowToken', 'content-type': 'application/json' };

		beforeAll(async () => {
			await db
				.insert(serverPeersTable)
				.values({
					id: 'serversPeersRoute-narrowServer',
					interfaceName: 'wg7c',
					cidrRange: '10.79.79.0/24',
					reservedIps: 1,
					wgAddress: '10.79.79.1',
					wgListenPort: 51879,
					wgEndpoint: 'testhost:51879',
					wgPrivateKey: 'privateKey',
					wgPublicKey: 'publicKey',
					authToken: 'serversPeersRoute-narrowToken',
				})
				.execute();
		});

		it("skips the server's own address when auto-allocating", async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/serversPeersRoute-narrowServer/peers', {
					method: 'POST',
					headers: narrowAuth,
					body: JSON.stringify({ friendlyName: 'first' }),
				}),
			);
			expect(response.status).toBe(200);
			expect((await response.json()).wgAddress).toBe('10.79.79.2');
		});

		it("rejects a peer that explicitly asks for the server's own address", async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/serversPeersRoute-narrowServer/peers', {
					method: 'POST',
					headers: narrowAuth,
					body: JSON.stringify({ friendlyName: 'greedy', wgAddress: '10.79.79.1' }),
				}),
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toContain('IP already in use');
		});
	});

	describe('DELETE /wg/servers/:id/peers/:peerId', () => {
		it('deletes the peer and converges the server', async () => {
			const [peer] = await db.query.peersTable.findMany({ where: (t, { eq }) => eq(t.serverPeerId, 'serversPeersRoute-server') });
			shellCallLog.reset();

			const response = await app.handle(new Request(`http://localhost/wg/servers/serversPeersRoute-server/peers/${peer.id}`, { method: 'DELETE', headers: auth }));
			expect(response.status).toBe(200);
			expect(shellCallLog.callsFor('wg7').length).toBeGreaterThan(0);

			const listResponse = await app.handle(new Request('http://localhost/wg/servers/serversPeersRoute-server/peers', { headers: auth }));
			expect(await listResponse.json()).toEqual([]);
		});

		it('returns 404 for an already-deleted peer', async () => {
			const response = await app.handle(new Request('http://localhost/wg/servers/serversPeersRoute-server/peers/does-not-exist', { method: 'DELETE', headers: auth }));
			expect(response.status).toBe(404);
		});
	});
});
