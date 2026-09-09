import { Elysia, status, t } from 'elysia';
import { db } from '../db';
import { peerTagAssignmentsTable, peerTagsTable, peersTable, policyGrantsTable, type Peer } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { wgDerivePublicKey, wgGenKey, wgGenPsk } from '../wg/shell';
import { converge } from '../wg/converge';
import { wgManager } from '../wg/manager';
import { resolvePeerAddress } from '../wg/addressing';
import { resolveServer } from '@server/db/servers';
import { loadPolicyGraph, tagIdsByPeer } from '@server/db/policyGraph';
import { auth } from './auth';
import { createLog } from '@server/lib/log';
import { generatePeerConfig } from '@server/wg/config';

const log = createLog('http');

async function assertTagsBelongToServer(tagIds: string[] | undefined, serverPeerId: string) {
	if (!tagIds || tagIds.length === 0) return null;
	const tags = await db.query.peerTagsTable.findMany({
		where: and(inArray(peerTagsTable.id, tagIds), eq(peerTagsTable.serverPeerId, serverPeerId)),
	});
	if (tags.length !== new Set(tagIds).size) {
		return status(400, 'One or more tags not found on this server');
	}
	return null;
}

async function setPeerTags(peerId: string, tagIds: string[]) {
	db.transaction((tx) => {
		tx.delete(peerTagAssignmentsTable).where(eq(peerTagAssignmentsTable.peerId, peerId)).run();
		for (const tagId of tagIds) {
			tx.insert(peerTagAssignmentsTable).values({ peerId, tagId }).run();
		}
	});
}

export const serversPeersRoute = new Elysia()
	.use(auth)
	.get(
		'/wg/servers/:id/peers',
		async ({ params }) => {
			const graph = await loadPolicyGraph(params.id);

			if (!graph) {
				return status(404, 'Server not found');
			}

			const tagIds = tagIdsByPeer(graph);

			const peersWithInfo: (Omit<Peer, 'wgLastRxBytes' | 'wgLastTxBytes' | 'wgLastSampledAt'> & {
				tagIds: string[];
				peerInfo: null | { connected: boolean; wgTransferRx: number; wgTransferTx: number; wgLatestHandshake: number; wgEndpoint: string };
			})[] = [];

			for (const peer of graph.peers) {
				// wgLast* are internal bookkeeping for wg/traffic.ts's delta computation - not for public consumption
				const { wgLastRxBytes, wgLastTxBytes, wgLastSampledAt, ...peerPublic } = peer;
				peersWithInfo.push({ ...peerPublic, tagIds: tagIds.get(peer.id) ?? [], peerInfo: wgManager.peerInfo[peer.wgPublicKey] ?? null });
			}

			return peersWithInfo;
		},
		{
			params: t.Object({
				id: t.String(),
			}),
			verifyAuth: { scope: 'server' },
		}
	)
	.post(
		'/wg/servers/:id/peers',
		async ({ params, body }) => {
			const server = await resolveServer(params.id);

			if (!server) {
				return status(404, 'Server not found');
			}

			const privateKey = await wgGenKey();
			const publicKey = await wgDerivePublicKey(privateKey);

			const existingPeers = await db.query.peersTable.findMany({
				where: eq(peersTable.serverPeerId, server.id),
				columns: { wgAddress: true },
			});
			const existingAddresses = new Set(existingPeers.map((p) => p.wgAddress));

			const resolved = resolvePeerAddress(server.cidrRange, server.reservedIps, existingAddresses, { requested: body.wgAddress });
			if (!resolved.ok) {
				return status(400, resolved.message);
			}
			const ip = resolved.ip;

			const tagError = await assertTagsBelongToServer(body.tagIds, server.id);
			if (tagError) return tagError;

			const peer = await db
				.insert(peersTable)
				.values({
					serverPeerId: server.id,
					friendlyName: body.friendlyName,

					wgPrivateKey: privateKey,
					wgPublicKey: publicKey,
					wgPresharedKey: await wgGenPsk(),

					wgAddress: ip,

					// the column default is a literal 0 (epoch) - see schema.ts's statsSince comment
					statsSince: new Date(),
				})
				.returning();

			if (body.tagIds?.length) {
				await setPeerTags(peer[0].id, body.tagIds);
			}

			log.info(`Created peer ${peer[0].id} on server ${server.id}`);
			const convergeResult = await converge(server.id);
			if (!convergeResult.ok) {
				log.warn(`Peer ${peer[0].id} created but server ${server.id} failed to converge: ${convergeResult.reason}`);
			}

			return { ...peer[0], tagIds: body.tagIds ?? [] };
		},
		{
			body: t.Object({
				friendlyName: t.Optional(t.String()),
				wgAddress: t.Optional(t.String()),
				tagIds: t.Optional(t.Array(t.String())),
			}),
			params: t.Object({
				id: t.String(),
			}),
			verifyAuth: { scope: 'server' },
		}
	)
	.patch(
		'/wg/servers/:id/peers/:peerId',
		async ({ params, body }) => {
			const server = await resolveServer(params.id);

			if (!server) {
				return status(404, 'Server not found');
			}

			const peer = await db.query.peersTable.findFirst({
				where: and(eq(peersTable.id, params.peerId), eq(peersTable.serverPeerId, server.id)),
			});

			if (!peer) {
				return status(404, 'Peer not found');
			}

			// only re-resolve an address when the request actually asks to change it - a PATCH
			// that just renames a peer or edits its tags must not spuriously fail because the
			// server's address range happens to be exhausted.
			let ip = peer.wgAddress;
			if (body.wgAddress) {
				const existingPeers = await db.query.peersTable.findMany({
					where: eq(peersTable.serverPeerId, server.id),
					columns: { wgAddress: true },
				});
				const existingAddresses = new Set(existingPeers.map((p) => p.wgAddress).filter((address) => address !== peer.wgAddress));

				const resolved = resolvePeerAddress(server.cidrRange, server.reservedIps, existingAddresses, { requested: body.wgAddress });
				if (!resolved.ok) {
					return status(400, resolved.message);
				}
				ip = resolved.ip;
			}

			// undefined = leave tags unchanged, [] = explicitly clear all tags (unrestrict)
			if (body.tagIds !== undefined) {
				const tagError = await assertTagsBelongToServer(body.tagIds, server.id);
				if (tagError) return tagError;
			}

			const updatedPeer = await db
				.update(peersTable)
				.set({
					friendlyName: body.friendlyName ?? peer.friendlyName,
					wgAddress: body.wgAddress ?? peer.wgAddress,
				})
				.where(and(eq(peersTable.id, params.peerId), eq(peersTable.serverPeerId, server.id)))
				.returning();

			if (body.tagIds !== undefined) {
				await setPeerTags(peer.id, body.tagIds);
			}

			log.info(`Updated peer ${peer.id} on server ${server.id}`);
			const convergeResult = await converge(server.id);
			if (!convergeResult.ok) {
				log.warn(`Peer ${peer.id} updated but server ${server.id} failed to converge: ${convergeResult.reason}`);
			}

			return updatedPeer;
		},
		{
			body: t.Object({
				friendlyName: t.Optional(t.String()),
				wgAddress: t.Optional(t.String()),
				tagIds: t.Optional(t.Array(t.String())),
			}),
			params: t.Object({
				id: t.String(),
				peerId: t.String(),
			}),
			verifyAuth: { scope: 'server' },
		}
	)
	.get(
		'/wg/servers/:id/peers/:peerId/config',
		async ({ params }) => {
			const server = await resolveServer(params.id);
			if (!server) {
				return status(404, 'Server not found');
			}

			const peer = await db.query.peersTable.findFirst({
				where: and(eq(peersTable.id, params.peerId), eq(peersTable.serverPeerId, server.id)),
			});

			if (!peer) {
				return status(404, 'Peer not found');
			}

			return generatePeerConfig(peer);
		},
		{
			params: t.Object({
				id: t.String(),
				peerId: t.String(),
			}),
			verifyAuth: { scope: 'server' },
		}
	)
	.delete(
		'/wg/servers/:id/peers/:peerId',
		async ({ params }) => {
			const server = await resolveServer(params.id);

			if (!server) {
				return status(404, 'Server not found');
			}

			const peer = await db.query.peersTable.findFirst({
				where: and(eq(peersTable.id, params.peerId), eq(peersTable.serverPeerId, server.id)),
			});

			if (!peer) {
				return status(404, 'Peer not found');
			}

			// no db-level FK enforcement (sqlite foreign_keys pragma isn't turned on anywhere in
			// this codebase), so cascade cleanup happens explicitly here - a peer-scoped grant
			// naming this peer directly would otherwise dangle.
			db.transaction((tx) => {
				tx.delete(peerTagAssignmentsTable).where(eq(peerTagAssignmentsTable.peerId, peer.id)).run();
				tx.delete(policyGrantsTable).where(eq(policyGrantsTable.srcPeerId, peer.id)).run();
				tx.delete(policyGrantsTable).where(eq(policyGrantsTable.dstPeerId, peer.id)).run();
				tx.delete(peersTable).where(eq(peersTable.id, params.peerId)).run();
			});
			log.info(`Deleted peer ${peer.id} from server ${server.id}`);
			const convergeResult = await converge(server.id);
			if (!convergeResult.ok) {
				log.warn(`Peer ${peer.id} deleted but server ${server.id} failed to converge: ${convergeResult.reason}`);
			}

			return { success: true };
		},
		{
			params: t.Object({
				id: t.String(),
				peerId: t.String(),
			}),
			verifyAuth: { scope: 'server' },
		}
	);
