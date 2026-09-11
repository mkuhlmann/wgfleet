import { serversPeersRoute } from './serversPeers';
import { db } from '../db';
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { peersTable, serverPeersTable } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { shellCallLog } from '@server/wg/shell';

// Advertised subnet routes (see wg/exitRouting.ts for the routing, wg/addressing.ts for the
// overlap rules). Like the exit-node invariants, the overlap rules are api-only - sqlite FK/check enforcement is never
// turned on here - so resolveAdvertisedRoutesFor in api/serversPeers.ts is the one place they
// hold. Fixture ids are prefixed per-file: the whole test run shares one in-memory database
// (see tests/setup.ts) - and because the overlap check is *host*-wide (it reads every server
// and peer, not just this interface's), so are the advertised CIDRs: everything here lives
// inside 172.28.0.0/16, which no other test file touches. Sharing a prefix with another file's
// fixtures would make these tests pass or fail depending on which of them ran.
const SERVER = 'subnetRoutes-server';
const OTHER = 'subnetRoutes-otherServer';

describe('advertised subnet routes', () => {
	const app = serversPeersRoute;
	const auth = { authorization: 'Bearer adminToken', 'content-type': 'application/json' };

	const post = (server: string, body: unknown) => app.handle(new Request(`http://localhost/wg/servers/${server}/peers`, { method: 'POST', headers: auth, body: JSON.stringify(body) }));

	const patch = (server: string, peerId: string, body: unknown) => app.handle(new Request(`http://localhost/wg/servers/${server}/peers/${peerId}`, { method: 'PATCH', headers: auth, body: JSON.stringify(body) }));

	const routesOf = async (peerId: string) => (await db.query.peersTable.findFirst({ where: eq(peersTable.id, peerId) }))?.advertisedRoutes;

	beforeAll(async () => {
		await db
			.insert(serverPeersTable)
			.values([
				{
					id: SERVER,
					interfaceName: 'wgSub0',
					cidrRange: '10.68.0.0/24',
					reservedIps: 2,
					wgAddress: '10.68.0.1',
					wgListenPort: 51968,
					wgEndpoint: 'subhost:51968',
					wgPrivateKey: 'privateKey',
					wgPublicKey: 'publicKey',
					routeTableId: 52700,
				},
				{
					id: OTHER,
					interfaceName: 'wgSub1',
					cidrRange: '10.69.0.0/24',
					reservedIps: 2,
					wgAddress: '10.69.0.1',
					wgListenPort: 51969,
					wgEndpoint: 'subhost:51969',
					wgPrivateKey: 'privateKey',
					wgPublicKey: 'publicKey',
					routeTableId: 52701,
				},
			])
			.execute();
	});

	beforeEach(async () => {
		await db.delete(peersTable).where(eq(peersTable.serverPeerId, SERVER));
		await db.delete(peersTable).where(eq(peersTable.serverPeerId, OTHER));

		await db
			.insert(peersTable)
			.values([
				{ id: 'subnetRoutes-router', serverPeerId: SERVER, friendlyName: 'branch-router', wgAddress: '10.68.0.2', wgPrivateKey: 'p', wgPublicKey: 'k', advertisedRoutes: '172.28.1.0/24' },
				{ id: 'subnetRoutes-client', serverPeerId: SERVER, wgAddress: '10.68.0.3', wgPrivateKey: 'p', wgPublicKey: 'k' },
				{ id: 'subnetRoutes-foreign', serverPeerId: OTHER, wgAddress: '10.69.0.2', wgPrivateKey: 'p', wgPublicKey: 'k' },
			])
			.execute();
	});

	describe('setting routes', () => {
		it('stores a list normalised: network-aligned and comma-separated', async () => {
			// CIDR_REGEX admits host bits, but `ip route` and nft both reject an unaligned
			// prefix - so the column can never hold one.
			const response = await patch(SERVER, 'subnetRoutes-client', { advertisedRoutes: '172.28.5.9/24, 172.28.6.0/24' });

			expect(response.status).toBe(200);
			expect(await routesOf('subnetRoutes-client')).toBe('172.28.5.0/24,172.28.6.0/24');
		});

		it('accepts routes at create time', async () => {
			const response = await post(SERVER, { friendlyName: 'new-router', advertisedRoutes: '172.28.20.0/24' });

			expect(response.status).toBe(200);
			expect((await response.json()).advertisedRoutes).toBe('172.28.20.0/24');
		});

		it('rejects a malformed or non-ipv4 prefix', async () => {
			expect((await patch(SERVER, 'subnetRoutes-client', { advertisedRoutes: '172.28.5.0' })).status).toBe(400);
			expect((await patch(SERVER, 'subnetRoutes-client', { advertisedRoutes: 'fd00::/64' })).status).toBe(400);
		});

		it('rejects a default route, pointing at the exit-node feature instead', async () => {
			const response = await patch(SERVER, 'subnetRoutes-client', { advertisedRoutes: '0.0.0.0/0' });

			expect(response.status).toBe(400);
			expect(await response.text()).toContain('exit node');
		});

		it("rejects a prefix overlapping the server's own range", async () => {
			const response = await patch(SERVER, 'subnetRoutes-client', { advertisedRoutes: '10.68.0.128/25' });

			expect(response.status).toBe(400);
			expect(await response.text()).toContain('10.68.0.0/24');
		});
	});

	describe('overlap between peers', () => {
		it("rejects a prefix that contains another peer's, not just an exact duplicate", async () => {
			// wireguard cryptokey routing has one owner per prefix, so the second advertiser
			// would silently steal the first one's traffic - the analogue of two exit nodes.
			const response = await patch(SERVER, 'subnetRoutes-client', { advertisedRoutes: '172.28.0.0/16' });

			expect(response.status).toBe(400);
			expect(await response.text()).toContain('branch-router');
		});

		it("rejects a prefix contained in another peer's", async () => {
			expect((await patch(SERVER, 'subnetRoutes-client', { advertisedRoutes: '172.28.1.128/25' })).status).toBe(400);
		});

		it('rejects an exact duplicate at create time too', async () => {
			expect((await post(SERVER, { advertisedRoutes: '172.28.1.0/24' })).status).toBe(400);
		});

		it('lets the advertiser keep its own prefix (idempotent PATCH)', async () => {
			// the peer being edited must not be compared against itself
			expect((await patch(SERVER, 'subnetRoutes-router', { advertisedRoutes: '172.28.1.0/24' })).status).toBe(200);
		});

		it('rejects the same prefix on a *different* interface too, naming it', async () => {
			// Per-interface would be enough for wireguard, but the route itself lives in the
			// host's single main routing table - two interfaces claiming one destination means
			// one of them silently loses. Rejected rather than left to whichever sync ran last.
			const response = await patch(OTHER, 'subnetRoutes-foreign', { advertisedRoutes: '172.28.1.0/24' });

			expect(response.status).toBe(400);
			expect(await response.text()).toContain('wgSub0');
		});

		it("rejects a prefix covering another interface's own vpn range", async () => {
			const response = await patch(SERVER, 'subnetRoutes-client', { advertisedRoutes: '10.69.0.0/24' });

			expect(response.status).toBe(400);
			expect(await response.text()).toContain('wgSub1');
		});

		it('accepts a disjoint prefix', async () => {
			expect((await patch(SERVER, 'subnetRoutes-client', { advertisedRoutes: '172.28.2.0/24' })).status).toBe(200);
		});
	});

	describe('clearing and leaving alone', () => {
		it('clears with null and with an empty string, both stored as null', async () => {
			expect((await patch(SERVER, 'subnetRoutes-router', { advertisedRoutes: null })).status).toBe(200);
			expect(await routesOf('subnetRoutes-router')).toBeNull();

			await patch(SERVER, 'subnetRoutes-router', { advertisedRoutes: '172.28.1.0/24' });
			await patch(SERVER, 'subnetRoutes-router', { advertisedRoutes: '' });
			expect(await routesOf('subnetRoutes-router')).toBeNull();
		});

		it('leaves the column untouched when the field is omitted', async () => {
			await patch(SERVER, 'subnetRoutes-router', { friendlyName: 'renamed' });

			expect(await routesOf('subnetRoutes-router')).toBe('172.28.1.0/24');
		});
	});

	describe('applying', () => {
		it('converges the interface and installs a main-table route, with no ip rule', async () => {
			// advertising changes the interface config (Table = off, the advertiser's server-side
			// AllowedIPs) as well as the host's routing, so it must converge, not just sync policy
			shellCallLog.reset();
			const response = await patch(SERVER, 'subnetRoutes-client', { advertisedRoutes: '172.28.30.0/24' });

			expect(response.status).toBe(200);
			expect(shellCallLog.callsFor('wgSub0').length).toBeGreaterThan(0);
			expect(shellCallLog.lastAppliedExitRouting()).toContain('ip -4 route replace 172.28.30.0/24 dev wgSub0 proto static');
			// destination-based: no per-client state at all. Scoped to this server's own table,
			// since syncExitRouting reads every server and the run shares one in-memory db.
			expect(shellCallLog.lastAppliedExitRouting()?.some((c) => c.includes('rule add') && c.includes('table 52700'))).toBe(false);
		});

		it('drops the route again when the advertisement is cleared', async () => {
			await patch(SERVER, 'subnetRoutes-client', { advertisedRoutes: '172.28.30.0/24' });
			shellCallLog.reset();

			await patch(SERVER, 'subnetRoutes-client', { advertisedRoutes: null });

			const applied = shellCallLog.lastAppliedExitRouting();
			expect(applied).toContain('ip -4 route flush dev wgSub0 proto static 2>/dev/null || true');
			expect(applied?.some((c) => c.includes('route replace 172.28.30.0/24'))).toBe(false);
		});
	});

	describe('composing with exit nodes', () => {
		it('lets one peer be both an exit node and an advertiser', async () => {
			const response = await patch(SERVER, 'subnetRoutes-router', { isExitNode: true, advertisedRoutes: '172.28.1.0/24' });

			expect(response.status).toBe(200);

			const peer = await db.query.peersTable.findFirst({ where: eq(peersTable.id, 'subnetRoutes-router') });
			expect(peer?.isExitNode).toBe(true);
			expect(peer?.advertisedRoutes).toBe('172.28.1.0/24');
		});

		it('serves the advertiser a gateway config scoped to its lan rather than a blanket masquerade', async () => {
			const response = await app.handle(new Request(`http://localhost/wg/servers/${SERVER}/peers/subnetRoutes-router/config?nat=true`, { headers: auth }));
			const text = await response.text();

			expect(text).toContain(
				'-s 10.68.0.0/24 -o $(r=$(ip -4 route show 172.28.1.0/24); [[ $r =~ dev[[:space:]]+([^[:space:]]+) ]] && echo ${BASH_REMATCH[1]})',
			);
			expect(text).not.toContain('ip -4 route show default');
		});
	});
});
