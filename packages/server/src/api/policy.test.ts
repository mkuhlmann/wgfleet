import { policyRoutes } from './policy';
import { db } from '../db';
import { beforeAll, describe, expect, it } from 'bun:test';
import { peersTable, serverPeersTable } from '@server/db/schema';

describe('policyRouter', () => {
	beforeAll(async () => {
		await db
			.insert(serverPeersTable)
			.values({
				id: 'policyRouter-server',
				friendlyName: 'Test Server',
				interfaceName: 'wg4',
				cidrRange: '10.60.60.0/24',
				reservedIps: 50,
				wgAddress: '10.60.60.1',
				wgListenPort: 51850,
				wgEndpoint: 'testhost:51850',
				wgPrivateKey: 'privateKey',
				wgPublicKey: 'publicKey',
				authToken: 'policyRouter-serverToken',
			})
			.execute();

		await db
			.insert(serverPeersTable)
			.values({
				id: 'policyRouter-otherServer',
				friendlyName: 'Other Server',
				interfaceName: 'wg5',
				cidrRange: '10.70.70.0/24',
				reservedIps: 50,
				wgAddress: '10.70.70.1',
				wgListenPort: 51860,
				wgEndpoint: 'otherhost:51860',
				wgPrivateKey: 'privateKey',
				wgPublicKey: 'publicKey',
				authToken: 'policyRouter-otherServerToken',
			})
			.execute();

		await db
			.insert(peersTable)
			.values({
				id: 'policyRouter-peer1',
				friendlyName: 'Laptop',
				authToken: 'policyRouter-peer1Token',
				serverPeerId: 'policyRouter-server',
				wgAddress: '10.60.60.2',
				wgPrivateKey: 'peerPrivateKey',
				wgPublicKey: 'peerPublicKey',
			})
			.execute();
	});

	const app = policyRoutes;
	const auth = { authorization: 'Bearer adminToken' };

	describe('/wg/servers/:id/tags', () => {
		it('GET should return 401 without a token', async () => {
			const response = await app.handle(new Request('http://localhost/wg/servers/policyRouter-server/tags'));
			expect(response.status).toBe(401);
		});

		it('GET should return 404 for an unknown server', async () => {
			const response = await app.handle(new Request('http://localhost/wg/servers/does-not-exist/tags', { headers: auth }));
			expect(response.status).toBe(404);
		});

		it('GET should return an empty list for a server with no tags', async () => {
			const response = await app.handle(new Request('http://localhost/wg/servers/policyRouter-server/tags', { headers: auth }));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual([]);
		});

		it('POST should create a tag', async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/tags', {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ name: 'dev', friendlyName: 'Dev' }),
				})
			);
			expect(response.status).toBe(200);
			const tag = await response.json();
			expect(tag.name).toBe('dev');
			expect(tag.serverPeerId).toBe('policyRouter-server');
		});

		it('POST should create a second tag', async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/tags', {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ name: 'db', friendlyName: 'Database' }),
				})
			);
			expect(response.status).toBe(200);
		});

		it('POST should reject a duplicate name on the same server', async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/tags', {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ name: 'dev' }),
				})
			);
			expect(response.status).toBe(400);
		});

		it('POST should reject an invalid name', async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/tags', {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ name: 'Not A Slug!' }),
				})
			);
			expect(response.status).toBe(422);
		});

		it('POST should allow the same name on a different server', async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-otherServer/tags', {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ name: 'dev' }),
				})
			);
			expect(response.status).toBe(200);
		});

		it('GET should list tags with memberCount', async () => {
			const response = await app.handle(new Request('http://localhost/wg/servers/policyRouter-server/tags', { headers: auth }));
			const tags = await response.json();
			expect(tags.length).toBe(2);
			expect(tags.find((t: any) => t.name === 'dev').memberCount).toBe(0);
		});
	});

	describe('/wg/servers/:id/tags/:tagId', () => {
		it('PATCH should update a tag', async () => {
			const tag = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-server'), eq(t.name, 'dev')) });

			const response = await app.handle(
				new Request(`http://localhost/wg/servers/policyRouter-server/tags/${tag!.id}`, {
					method: 'PATCH',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ friendlyName: 'Developers' }),
				})
			);
			expect(response.status).toBe(200);
			const updated = await response.json();
			expect(updated.friendlyName).toBe('Developers');
		});

		it('PATCH should return 404 for a tag on a different server', async () => {
			const tag = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-otherServer'), eq(t.name, 'dev')) });

			const response = await app.handle(
				new Request(`http://localhost/wg/servers/policyRouter-server/tags/${tag!.id}`, {
					method: 'PATCH',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ friendlyName: 'x' }),
				})
			);
			expect(response.status).toBe(404);
		});
	});

	describe('/wg/servers/:id/grants', () => {
		it('PUT should reject a srcTagId belonging to a different server', async () => {
			const dev = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-server'), eq(t.name, 'dev')) });
			const otherDev = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-otherServer'), eq(t.name, 'dev')) });

			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/grants', {
					method: 'PUT',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ grants: [{ action: 'allow', srcKind: 'tag', srcTagId: otherDev!.id, dstKind: 'tag', dstTagId: dev!.id }] }),
				})
			);
			expect(response.status).toBe(400);
		});

		it('PUT should reject an invalid dstCidr', async () => {
			const dev = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-server'), eq(t.name, 'dev')) });

			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/grants', {
					method: 'PUT',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ grants: [{ action: 'allow', srcKind: 'tag', srcTagId: dev!.id, dstKind: 'cidr', dstCidr: 'not-a-cidr' }] }),
				})
			);
			expect(response.status).toBe(400);
		});

		it('PUT should reject an ipv6 dstCidr (the firewall this feeds is ipv4-only)', async () => {
			const dev = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-server'), eq(t.name, 'dev')) });

			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/grants', {
					method: 'PUT',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ grants: [{ action: 'allow', srcKind: 'tag', srcTagId: dev!.id, dstKind: 'cidr', dstCidr: 'fd00::/64' }] }),
				})
			);
			expect(response.status).toBe(400);
		});

		it('PUT should reject ports on a non tcp/udp protocol', async () => {
			const dev = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-server'), eq(t.name, 'dev')) });
			const dbTag = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-server'), eq(t.name, 'db')) });

			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/grants', {
					method: 'PUT',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ grants: [{ action: 'allow', srcKind: 'tag', srcTagId: dev!.id, dstKind: 'tag', dstTagId: dbTag!.id, protocol: 'icmp', ports: '80' }] }),
				})
			);
			expect(response.status).toBe(400);
		});

		it('PUT should reject malformed ports', async () => {
			const dev = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-server'), eq(t.name, 'dev')) });
			const dbTag = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-server'), eq(t.name, 'db')) });

			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/grants', {
					method: 'PUT',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ grants: [{ action: 'allow', srcKind: 'tag', srcTagId: dev!.id, dstKind: 'tag', dstTagId: dbTag!.id, protocol: 'tcp', ports: 'abc' }] }),
				})
			);
			expect(response.status).toBe(400);
		});

		it('PUT should replace the grant list atomically and preserve order as position', async () => {
			const dev = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-server'), eq(t.name, 'dev')) });
			const dbTag = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-server'), eq(t.name, 'db')) });

			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/grants', {
					method: 'PUT',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						grants: [
							{ action: 'deny', srcKind: 'peer', srcPeerId: 'policyRouter-peer1', dstKind: 'tag', dstTagId: dbTag!.id },
							{ action: 'allow', srcKind: 'tag', srcTagId: dev!.id, dstKind: 'tag', dstTagId: dbTag!.id, protocol: 'tcp', ports: '5432' },
						],
					}),
				})
			);
			expect(response.status).toBe(200);
			const grants = await response.json();
			expect(grants.length).toBe(2);
			expect(grants[0].action).toBe('deny');
			expect(grants[0].position).toBeLessThan(grants[1].position);
			expect(grants[1].ports).toBe('5432');
		});

		it('GET should return grants ordered by position', async () => {
			const response = await app.handle(new Request('http://localhost/wg/servers/policyRouter-server/grants', { headers: auth }));
			const grants = await response.json();
			expect(grants.length).toBe(2);
			expect(grants[0].action).toBe('deny');
			expect(grants[1].action).toBe('allow');
		});
	});

	describe('/wg/servers/:id/policy (json document)', () => {
		it('GET should return the whole document shape', async () => {
			const response = await app.handle(new Request('http://localhost/wg/servers/policyRouter-server/policy', { headers: auth }));
			expect(response.status).toBe(200);
			const doc = await response.json();
			expect(doc.tags.map((t: any) => t.name).sort()).toEqual(['db', 'dev']);
			expect(doc.grants.length).toBe(2);
			expect(doc.peerTags).toEqual([]); // no peer has any tag assigned yet
		});

		it('PUT should reject a document referencing an unknown tag name', async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/policy', {
					method: 'PUT',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						tags: [{ name: 'dev' }],
						grants: [{ action: 'allow', srcKind: 'tag', srcTag: 'dev', dstKind: 'tag', dstTag: 'ghost' }],
						peerTags: [],
					}),
				})
			);
			expect(response.status).toBe(400);
		});

		it('PUT should reject a document with a duplicate tag name', async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/policy', {
					method: 'PUT',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ tags: [{ name: 'dev' }, { name: 'dev' }], grants: [], peerTags: [] }),
				})
			);
			expect(response.status).toBe(400);
		});

		it('PUT should reject a document referencing an unknown peer', async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/policy', {
					method: 'PUT',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ tags: [{ name: 'dev' }], grants: [], peerTags: [{ peerId: 'does-not-exist', tags: ['dev'] }] }),
				})
			);
			expect(response.status).toBe(400);
		});

		it('a rejected PUT must not partially apply (the previous document survives untouched)', async () => {
			const before = await app.handle(new Request('http://localhost/wg/servers/policyRouter-server/policy', { headers: auth }));
			const beforeDoc = await before.json();

			const rejected = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/policy', {
					method: 'PUT',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ tags: [{ name: 'newtag' }], grants: [{ action: 'allow', srcKind: 'tag', srcTag: 'newtag', dstKind: 'cidr', dstCidr: 'not-a-cidr' }], peerTags: [] }),
				})
			);
			expect(rejected.status).toBe(400);

			const after = await app.handle(new Request('http://localhost/wg/servers/policyRouter-server/policy', { headers: auth }));
			const afterDoc = await after.json();
			expect(afterDoc).toEqual(beforeDoc);
		});

		it('PUT should import a full document, replacing tags/grants/assignments transactionally', async () => {
			const response = await app.handle(
				new Request('http://localhost/wg/servers/policyRouter-server/policy', {
					method: 'PUT',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						tags: [{ name: 'dev', friendlyName: 'Dev' }, { name: 'db' }],
						grants: [{ action: 'allow', srcKind: 'tag', srcTag: 'dev', dstKind: 'tag', dstTag: 'db', protocol: 'tcp', ports: '5432' }],
						peerTags: [{ peerId: 'policyRouter-peer1', tags: ['dev'] }],
					}),
				})
			);
			expect(response.status).toBe(200);
			const doc = await response.json();
			expect(doc.tags.map((t: any) => t.name).sort()).toEqual(['db', 'dev']);
			expect(doc.grants.length).toBe(1);
			expect(doc.grants[0].srcTag).toBe('dev');
			expect(doc.grants[0].dstTag).toBe('db');
			expect(doc.peerTags).toEqual([{ peerId: 'policyRouter-peer1', friendlyName: 'Laptop', tags: ['dev'] }]);
		});
	});

	describe('DELETE /wg/servers/:id/tags/:tagId', () => {
		it('should unassign member peers and remove referencing grants before deleting', async () => {
			const dbTag = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-server'), eq(t.name, 'db')) });

			const response = await app.handle(
				new Request(`http://localhost/wg/servers/policyRouter-server/tags/${dbTag!.id}`, {
					method: 'DELETE',
					headers: auth,
				})
			);
			expect(response.status).toBe(200);

			const stillThere = await db.query.peerTagsTable.findFirst({ where: (t, { eq }) => eq(t.id, dbTag!.id) });
			expect(stillThere).toBeUndefined();

			const grants = await db.query.policyGrantsTable.findMany({ where: (t, { eq }) => eq(t.dstTagId, dbTag!.id) });
			expect(grants.length).toBe(0);
		});

		it('should return 404 for an already-deleted tag', async () => {
			const dev = await db.query.peerTagsTable.findFirst({ where: (t, { eq, and }) => and(eq(t.serverPeerId, 'policyRouter-otherServer'), eq(t.name, 'dev')) });

			const first = await app.handle(new Request(`http://localhost/wg/servers/policyRouter-otherServer/tags/${dev!.id}`, { method: 'DELETE', headers: auth }));
			expect(first.status).toBe(200);

			const second = await app.handle(new Request(`http://localhost/wg/servers/policyRouter-otherServer/tags/${dev!.id}`, { method: 'DELETE', headers: auth }));
			expect(second.status).toBe(404);
		});
	});
});
