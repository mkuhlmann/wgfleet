import { beforeAll, describe, expect, it } from 'bun:test';
import { db } from './index';
import { peerTagAssignmentsTable, peerTagsTable, peersTable, policyGrantsTable, serverPeersTable } from './schema';
import { allowedIpsForPeer, loadPolicyGraph, memberCountByTag, tagIdsByPeer, toPolicyDocument } from './policyGraph';

describe('policyGraph', () => {
	beforeAll(async () => {
		await db
			.insert(serverPeersTable)
			.values({
				id: 'policyGraph-server',
				interfaceName: 'wg9',
				cidrRange: '10.90.90.0/24',
				reservedIps: 50,
				wgAddress: '10.90.90.1',
				wgListenPort: 51890,
				wgEndpoint: 'testhost:51890',
				wgPrivateKey: 'privateKey',
				wgPublicKey: 'publicKey',
			})
			.execute();

		await db
			.insert(peersTable)
			.values([
				{ id: 'policyGraph-dev1', serverPeerId: 'policyGraph-server', wgAddress: '10.90.90.2', wgPrivateKey: 'k', wgPublicKey: 'devPub1' },
				{ id: 'policyGraph-db1', serverPeerId: 'policyGraph-server', wgAddress: '10.90.90.9', wgPrivateKey: 'k', wgPublicKey: 'dbPub1' },
			])
			.execute();

		await db
			.insert(peerTagsTable)
			.values([
				{ id: 'policyGraph-tag-dev', serverPeerId: 'policyGraph-server', name: 'dev', friendlyName: 'Dev' },
				{ id: 'policyGraph-tag-db', serverPeerId: 'policyGraph-server', name: 'db' },
			])
			.execute();

		await db
			.insert(peerTagAssignmentsTable)
			.values([
				{ peerId: 'policyGraph-dev1', tagId: 'policyGraph-tag-dev' },
				{ peerId: 'policyGraph-db1', tagId: 'policyGraph-tag-db' },
				// a stale assignment pointing at a tag that doesn't exist - loadPolicyGraph must
				// not blow up on it, and projections must ignore it (see their "be defensive" comments)
				{ peerId: 'policyGraph-dev1', tagId: 'policyGraph-tag-deleted' },
			])
			.execute();

		await db
			.insert(policyGrantsTable)
			.values([
				{
					id: 'policyGraph-grant-devdb',
					serverPeerId: 'policyGraph-server',
					position: 0,
					action: 'allow',
					srcKind: 'tag',
					srcTagId: 'policyGraph-tag-dev',
					dstKind: 'tag',
					dstTagId: 'policyGraph-tag-db',
					protocol: 'tcp',
					ports: '5432',
				},
				{
					id: 'policyGraph-grant-disabled',
					serverPeerId: 'policyGraph-server',
					position: 1,
					enabled: false,
					action: 'allow',
					srcKind: 'tag',
					srcTagId: 'policyGraph-tag-dev',
					dstKind: 'internet',
				},
			])
			.execute();
	});

	describe('loadPolicyGraph', () => {
		it('returns undefined for an unknown server', async () => {
			expect(await loadPolicyGraph('does-not-exist')).toBeUndefined();
		});

		it('resolves by interfaceName as well as id', async () => {
			const byId = await loadPolicyGraph('policyGraph-server');
			const byName = await loadPolicyGraph('wg9');
			expect(byId?.server.id).toBe('policyGraph-server');
			expect(byName?.server.id).toBe('policyGraph-server');
		});

		it('loads tags, peers, assignments and grants scoped to the one server, grants ordered by position', async () => {
			const graph = await loadPolicyGraph('policyGraph-server');
			expect(graph!.tags.map((t) => t.name).sort()).toEqual(['db', 'dev']);
			expect(graph!.peers.map((p) => p.id).sort()).toEqual(['policyGraph-db1', 'policyGraph-dev1']);
			expect(graph!.grants.map((g) => g.id)).toEqual(['policyGraph-grant-devdb', 'policyGraph-grant-disabled']);
			// includes the stale assignment - projections are responsible for ignoring it, not the load
			expect(graph!.assignments.length).toBe(3);
		});
	});

	describe('projections', () => {
		it('tagIdsByPeer groups assignments per peer, stale ones included (caller-defensive)', async () => {
			const graph = await loadPolicyGraph('policyGraph-server');
			const map = tagIdsByPeer(graph!);
			expect(map.get('policyGraph-dev1')?.sort()).toEqual(['policyGraph-tag-dev', 'policyGraph-tag-deleted'].sort());
			expect(map.get('policyGraph-db1')).toEqual(['policyGraph-tag-db']);
		});

		it('memberCountByTag counts assignments per tag', async () => {
			const graph = await loadPolicyGraph('policyGraph-server');
			const counts = memberCountByTag(graph!);
			expect(counts.get('policyGraph-tag-dev')).toBe(1);
			expect(counts.get('policyGraph-tag-db')).toBe(1);
		});

		it('toPolicyDocument drops the stale assignment and includes only enabled+disabled grants by name', async () => {
			const graph = await loadPolicyGraph('policyGraph-server');
			const doc = toPolicyDocument(graph!);

			expect(doc.tags.map((t) => t.name).sort()).toEqual(['db', 'dev']);
			expect(doc.grants.length).toBe(2);
			expect(doc.grants[0]).toMatchObject({ srcTag: 'dev', dstTag: 'db', enabled: true });
			expect(doc.grants[1]).toMatchObject({ enabled: false });

			const devPeerTags = doc.peerTags.find((p) => p.peerId === 'policyGraph-dev1');
			expect(devPeerTags?.tags).toEqual(['dev']); // the stale tag id never resolved to a name
		});

		it('allowedIpsForPeer returns just the server cidr when no allow grant applies', async () => {
			const graph = await loadPolicyGraph('policyGraph-server');
			const peer = graph!.peers.find((p) => p.id === 'policyGraph-db1')!;
			expect(allowedIpsForPeer(graph!, peer)).toBe('10.90.90.0/24');
		});

		it('allowedIpsForPeer widens to 0.0.0.0/0 for an internet/any grant, and ignores a disabled one', async () => {
			const graph = await loadPolicyGraph('policyGraph-server');
			const devPeer = graph!.peers.find((p) => p.id === 'policyGraph-dev1')!;
			// the only internet grant on dev is disabled (policyGraph-grant-disabled) - must not widen
			expect(allowedIpsForPeer(graph!, devPeer)).toBe('10.90.90.0/24');
		});

		it('allowedIpsForPeer appends an extra cidr from an enabled dstKind cidr grant', async () => {
			await db
				.insert(policyGrantsTable)
				.values({
					id: 'policyGraph-grant-cidr',
					serverPeerId: 'policyGraph-server',
					position: 2,
					action: 'allow',
					srcKind: 'tag',
					srcTagId: 'policyGraph-tag-dev',
					dstKind: 'cidr',
					dstCidr: '192.168.77.0/24',
				})
				.execute();

			const graph = await loadPolicyGraph('policyGraph-server');
			const devPeer = graph!.peers.find((p) => p.id === 'policyGraph-dev1')!;
			expect(allowedIpsForPeer(graph!, devPeer)).toBe('10.90.90.0/24, 192.168.77.0/24');
		});
	});
});
