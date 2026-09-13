import { beforeAll, describe, expect, it } from 'bun:test';
import { db } from '../db';
import { peersTable, serverPeersTable } from '@server/db/schema';
import { serversPeersRoute } from './serversPeers';
import { serversRoutes } from './servers';

// The wire contract every failing response obeys. It was previously asserted by nothing on
// either side of the seam - domain refusals were bare text, TypeBox violations were Elysia's
// own json, and the client had three decode branches guessing between them.
const SERVER = 'failureRoute-server';
const auth = { authorization: 'Bearer failureRoute-token', 'content-type': 'application/json' };

const body = async (response: Response) => (await response.json()) as { message?: string; field?: string };

describe('failure responses', () => {
	beforeAll(async () => {
		await db
			.insert(serverPeersTable)
			.values({
				id: SERVER,
				interfaceName: 'wgFail0',
				cidrRange: '10.83.83.0/24',
				reservedIps: 10,
				wgAddress: '10.83.83.1',
				wgListenPort: 51883,
				wgEndpoint: 'testhost:51883',
				wgPrivateKey: 'privateKey',
				wgPublicKey: 'publicKey',
				authToken: 'failureRoute-token',
			})
			.execute();

		await db.insert(peersTable).values({ id: 'failureRoute-peer', serverPeerId: SERVER, wgAddress: '10.83.83.20', wgPrivateKey: 'k', wgPublicKey: 'p' }).execute();
	});

	it('names the field a peer write was refused for, so a form can point at it', async () => {
		const response = await serversPeersRoute.handle(new Request(`http://localhost/wg/servers/${SERVER}/peers`, { method: 'POST', headers: auth, body: JSON.stringify({ wgAddress: '10.83.83.20' }) }));

		expect(response.status).toBe(400);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(await body(response)).toEqual({ message: 'IP already in use', field: 'wgAddress' });
	});

	it('names the field for each distinct rule, not one catch-all', async () => {
		const conflicting = await serversPeersRoute.handle(new Request(`http://localhost/wg/servers/${SERVER}/peers/failureRoute-peer`, { method: 'PATCH', headers: auth, body: JSON.stringify({ isExitNode: true, exitPeerId: 'failureRoute-peer' }) }));
		expect(await body(conflicting)).toMatchObject({ field: 'isExitNode' });

		const unknownTag = await serversPeersRoute.handle(new Request(`http://localhost/wg/servers/${SERVER}/peers/failureRoute-peer`, { method: 'PATCH', headers: auth, body: JSON.stringify({ tagIds: ['nope'] }) }));
		expect(await body(unknownTag)).toMatchObject({ field: 'tagIds' });

		const badRoute = await serversPeersRoute.handle(new Request(`http://localhost/wg/servers/${SERVER}/peers/failureRoute-peer`, { method: 'PATCH', headers: auth, body: JSON.stringify({ advertisedRoutes: 'not-a-cidr' }) }));
		expect(await body(badRoute)).toMatchObject({ field: 'advertisedRoutes' });
	});

	it('carries a message but no field where the failure is about the request itself', async () => {
		const unauthorized = await serversPeersRoute.handle(new Request(`http://localhost/wg/servers/${SERVER}/peers`, { method: 'GET' }));

		expect(unauthorized.status).toBe(401);
		expect(await body(unauthorized)).toEqual({ message: 'Unauthorized' });

		const missing = await serversPeersRoute.handle(new Request('http://localhost/wg/servers/nope/peers', { method: 'GET', headers: { authorization: 'Bearer adminToken' } }));
		expect(missing.status).toBe(404);
		expect(await body(missing)).toEqual({ message: 'Server not found' });
	});

	it('uses the same shape for a server write', async () => {
		// passes CIDR_REGEX (which only counts digits) but is not a valid network
		const response = await serversRoutes.handle(
			new Request('http://localhost/wg/servers', {
				method: 'POST',
				headers: { authorization: 'Bearer adminToken', 'content-type': 'application/json' },
				body: JSON.stringify({ friendlyName: 'fail', interfaceName: 'wgFail9', cidrRange: '999.1.1.0/24', wgAddress: '10.9.9.1', wgListenPort: 51899, wgEndpoint: 'h:51899' }),
			}),
		);

		expect(response.status).toBe(400);
		expect(await body(response)).toEqual({ message: 'Invalid CIDR range', field: 'cidrRange' });
	});

	it("keeps a schema violation's own shape readable by the same decoder", async () => {
		// Elysia validates `body` before a handler runs, so this one is not ours to format -
		// but it is json with a `message`, which is what the client decodes.
		const response = await serversRoutes.handle(
			new Request('http://localhost/wg/servers', {
				method: 'POST',
				headers: { authorization: 'Bearer adminToken', 'content-type': 'application/json' },
				body: JSON.stringify({ friendlyName: 'fail', interfaceName: 'this name is far too long to be an interface', cidrRange: '10.9.9.0/24', wgAddress: '10.9.9.1', wgListenPort: 51899, wgEndpoint: 'h:51899' }),
			}),
		);

		expect(response.status).toBe(422);
		expect(await body(response)).toMatchObject({ message: expect.any(String) });
	});
});
