import { beforeAll, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { db } from '@server/db';
import { peersTable, serverPeersTable, trafficBucketsTable } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { trafficRoutes } from './traffic';

// Fixture ids and cidr are prefixed/unique per file - the test run shares one in-memory db
// across every test file (see tests/setup.ts).
const SERVER = 'trafficRouter-server';
const PEER = 'trafficRouter-peer';
const OTHER_SERVER = 'trafficRouter-otherServer';
const OTHER_PEER = 'trafficRouter-otherPeer';

const app = new Elysia().group('/api/v1', (a) => a.use(trafficRoutes));

const get = (path: string, token = 'adminToken') => app.handle(new Request(`http://localhost/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }));

const post = (path: string, token = 'adminToken') => app.handle(new Request(`http://localhost/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }));

describe('trafficRoutes', () => {
	beforeAll(async () => {
		await db
			.insert(serverPeersTable)
			.values([
				{
					id: SERVER,
					interfaceName: 'wgTraffic',
					cidrRange: '10.61.0.0/24',
					reservedIps: 50,
					wgAddress: '10.61.0.1',
					wgListenPort: 51861,
					wgEndpoint: 'testhost:51861',
					wgPrivateKey: 'privateKey',
					wgPublicKey: 'publicKey',
					authToken: 'trafficServerToken',
					lifetimeRxBytes: 500,
					lifetimeTxBytes: 700,
				},
				{
					id: OTHER_SERVER,
					interfaceName: 'wgTrafficB',
					cidrRange: '10.62.0.0/24',
					reservedIps: 50,
					wgAddress: '10.62.0.1',
					wgListenPort: 51862,
					wgEndpoint: 'testhost:51862',
					wgPrivateKey: 'privateKey',
					wgPublicKey: 'publicKey',
				},
			])
			.execute();

		await db
			.insert(peersTable)
			.values([
				{ id: PEER, serverPeerId: SERVER, wgAddress: '10.61.0.51', wgPrivateKey: 'k', wgPublicKey: 'p', lifetimeRxBytes: 100, lifetimeTxBytes: 200 },
				{ id: OTHER_PEER, serverPeerId: OTHER_SERVER, wgAddress: '10.62.0.51', wgPrivateKey: 'k', wgPublicKey: 'p' },
			])
			.execute();

		await db
			.insert(trafficBucketsTable)
			.values([
				{ peerId: PEER, serverPeerId: SERVER, resolution: '1m', bucketStart: new Date('2026-01-01T00:00:00Z'), rxBytes: 10, txBytes: 20 },
				{ peerId: PEER, serverPeerId: SERVER, resolution: '1m', bucketStart: new Date('2026-01-01T00:01:00Z'), rxBytes: 30, txBytes: 40 },
				// a different resolution for the same peer - must not leak into the 1m series
				{ peerId: PEER, serverPeerId: SERVER, resolution: '1h', bucketStart: new Date('2026-01-01T00:00:00Z'), rxBytes: 999, txBytes: 999 },
			])
			.execute();
	});

	describe('GET /wg/servers/:id/traffic', () => {
		it('sums its peers buckets for the requested resolution', async () => {
			const res = await get(`/wg/servers/${SERVER}/traffic?resolution=1m`);
			expect(res.status).toBe(200);

			const body = (await res.json()) as { resolution: string; buckets: { rxBytes: number; txBytes: number }[] };
			expect(body.resolution).toBe('1m');
			expect(body.buckets).toHaveLength(2);
			expect(body.buckets.map((b) => b.rxBytes)).toEqual([10, 30]);
		});

		it('accepts the server-scoped token', async () => {
			expect((await get(`/wg/servers/${SERVER}/traffic?resolution=1m`, 'trafficServerToken')).status).toBe(200);
		});

		it('rejects another server token with 401 rather than leaking existence', async () => {
			expect((await get(`/wg/servers/${SERVER}/traffic?resolution=1m`, 'wrongToken')).status).toBe(401);
			expect((await get(`/wg/servers/does-not-exist/traffic?resolution=1m`, 'wrongToken')).status).toBe(401);
		});

		it('404s an unknown server for an authorized caller', async () => {
			expect((await get('/wg/servers/does-not-exist/traffic?resolution=1m')).status).toBe(404);
		});
	});

	describe('GET /wg/servers/:id/peers/:peerId/traffic', () => {
		it('returns that peer’s buckets', async () => {
			const res = await get(`/wg/servers/${SERVER}/peers/${PEER}/traffic?resolution=1m`);
			expect(res.status).toBe(200);
			expect(((await res.json()) as { buckets: unknown[] }).buckets).toHaveLength(2);
		});

		it('404s a peer that belongs to another server', async () => {
			expect((await get(`/wg/servers/${SERVER}/peers/${OTHER_PEER}/traffic?resolution=1m`)).status).toBe(404);
		});
	});

	describe('POST .../traffic/reset', () => {
		it('zeroes the server lifetime counters', async () => {
			expect((await post(`/wg/servers/${SERVER}/traffic/reset`)).status).toBe(200);

			const row = await db.query.serverPeersTable.findFirst({ where: eq(serverPeersTable.id, SERVER) });
			expect(row?.lifetimeRxBytes).toBe(0);
			expect(row?.lifetimeTxBytes).toBe(0);
		});

		it('zeroes the peer lifetime counters', async () => {
			expect((await post(`/wg/servers/${SERVER}/peers/${PEER}/traffic/reset`)).status).toBe(200);

			const row = await db.query.peersTable.findFirst({ where: eq(peersTable.id, PEER) });
			expect(row?.lifetimeRxBytes).toBe(0);
			expect(row?.lifetimeTxBytes).toBe(0);
		});

		it('404s a peer that belongs to another server', async () => {
			expect((await post(`/wg/servers/${SERVER}/peers/${OTHER_PEER}/traffic/reset`)).status).toBe(404);
		});
	});
});
