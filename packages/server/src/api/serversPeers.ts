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

// Query for both peer-config routes (here and api/peers.ts). `exit` renders the "via exit
// node" variant, `nat` appends the gateway PostUp lines - see wg/config.ts's
// PeerConfigOptions. BooleanString because query values arrive as strings.
export const PEER_CONFIG_QUERY = t.Object({
	exit: t.Optional(t.BooleanString({ default: false })),
	nat: t.Optional(t.BooleanString({ default: false })),
});

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

/**
 * Exit-node invariants (see wg/exitRouting.ts and docs/design/exit-nodes.md). None of these
 * are db constraints - sqlite FK enforcement is never turned on in this codebase - so this is
 * the one place they hold. `peer` is null on create, where the two rules that need an
 * existing row (unmarking, and the grant conflict) cannot apply yet.
 */
async function assertExitNodeInvariants(serverPeerId: string, peer: Peer | null, body: { isExitNode?: boolean; exitPeerId?: string | null }) {
	const isExitNode = body.isExitNode ?? peer?.isExitNode ?? false;
	const exitPeerId = body.exitPeerId === undefined ? (peer?.exitPeerId ?? null) : body.exitPeerId;

	// An exit node routing its own internet traffic into itself is a loop, and its config
	// can't express both roles anyway (it needs cidrRange AllowedIPs, not 0.0.0.0/0).
	if (isExitNode && exitPeerId) {
		return status(400, 'A peer cannot be an exit node and use an exit node at the same time');
	}

	if (body.isExitNode === true) {
		// Only one peer per wg interface can own AllowedIPs 0.0.0.0/0 - a second exit node
		// needs a second interface. This is a wireguard cryptokey-routing constraint, not a
		// policy choice, so it's rejected rather than silently resolved.
		const existing = await db.query.peersTable.findMany({
			where: and(eq(peersTable.serverPeerId, serverPeerId), eq(peersTable.isExitNode, true)),
		});
		const other = existing.find((p) => p.id !== peer?.id);
		if (other) {
			return status(400, `This server already has an exit node (${other.friendlyName ?? other.wgAddress}). Only one peer per interface can be an exit node.`);
		}
	}

	if (peer && body.isExitNode === false && peer.isExitNode) {
		// Fail closed and loudly: silently unassigning the dependents would leave them with no
		// internet at all, with nothing in the UI explaining why.
		const dependents = await db.query.peersTable.findMany({ where: eq(peersTable.exitPeerId, peer.id) });
		if (dependents.length) {
			const names = dependents.map((p) => p.friendlyName ?? p.wgAddress).join(', ');
			return status(400, `Still in use as an exit node by: ${names}. Reassign those peers first.`);
		}
	}

	if (body.exitPeerId) {
		if (peer && body.exitPeerId === peer.id) {
			return status(400, 'A peer cannot use itself as its exit node');
		}

		const target = await db.query.peersTable.findFirst({
			where: and(eq(peersTable.id, body.exitPeerId), eq(peersTable.serverPeerId, serverPeerId)),
		});

		if (!target) {
			return status(400, 'Exit node not found on this server');
		}

		if (!target.isExitNode) {
			return status(400, 'That peer is not marked as an exit node');
		}

		// Routing wins over an `internet` grant: with an exitPeerId set, the ip rule sends this
		// peer's traffic to the exit node and it never reaches the hub's own uplink, so the
		// grant would be silently inert. Rejecting keeps the db out of a state the UI's
		// three-way internet selector can't display. Only checkable for a grant naming the peer
		// directly - a tag-derived internet grant depends on the whole policy graph and is left
		// to the UI (documented in docs/design/exit-nodes.md).
		if (peer) {
			const conflicting = await db.query.policyGrantsTable.findFirst({
				where: and(
					eq(policyGrantsTable.serverPeerId, serverPeerId),
					eq(policyGrantsTable.srcKind, 'peer'),
					eq(policyGrantsTable.srcPeerId, peer.id),
					eq(policyGrantsTable.dstKind, 'internet'),
					eq(policyGrantsTable.action, 'allow'),
					eq(policyGrantsTable.enabled, true)
				),
			});
			if (conflicting) {
				return status(400, 'This peer has an "allow -> internet" grant (internet via the hub). Remove it before assigning an exit node.');
			}
		}
	}

	return null;
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

			const exitError = await assertExitNodeInvariants(server.id, null, body);
			if (exitError) return exitError;

			const peer = await db
				.insert(peersTable)
				.values({
					serverPeerId: server.id,
					friendlyName: body.friendlyName,

					wgPrivateKey: privateKey,
					wgPublicKey: publicKey,
					wgPresharedKey: await wgGenPsk(),

					wgAddress: ip,

					isExitNode: body.isExitNode ?? false,
					exitPeerId: body.exitPeerId ?? null,
					exitDns: body.exitDns ?? null,

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
				isExitNode: t.Optional(t.Boolean()),
				exitPeerId: t.Optional(t.Nullable(t.String())),
				exitDns: t.Optional(t.Nullable(t.String())),
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

			const exitError = await assertExitNodeInvariants(server.id, peer, body);
			if (exitError) return exitError;

			const updatedPeer = await db
				.update(peersTable)
				.set({
					friendlyName: body.friendlyName ?? peer.friendlyName,
					wgAddress: body.wgAddress ?? peer.wgAddress,
					isExitNode: body.isExitNode ?? peer.isExitNode,
					// undefined = unchanged, null = explicitly clear (no exit node / no override)
					exitPeerId: body.exitPeerId === undefined ? peer.exitPeerId : body.exitPeerId,
					exitDns: body.exitDns === undefined ? peer.exitDns : body.exitDns,
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
				isExitNode: t.Optional(t.Boolean()),
				exitPeerId: t.Optional(t.Nullable(t.String())),
				exitDns: t.Optional(t.Nullable(t.String())),
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
		async ({ params, query }) => {
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

			return generatePeerConfig(peer, { exit: query.exit, nat: query.nat });
		},
		{
			params: t.Object({
				id: t.String(),
				peerId: t.String(),
			}),
			query: PEER_CONFIG_QUERY,
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
			// Deleting an exit node outright is allowed (unlike merely unmarking it, which is
			// rejected while dependents exist - see assertExitNodeInvariants): the peer is gone,
			// so there is nothing to reassign to. Its clients lose internet access rather than
			// silently falling back to the hub's uplink, which would push their traffic out the
			// exact interface an exit node exists to avoid. They're named in the response so the
			// ui can say so.
			const dependents = peer.isExitNode ? await db.query.peersTable.findMany({ where: eq(peersTable.exitPeerId, peer.id) }) : [];

			db.transaction((tx) => {
				tx.delete(peerTagAssignmentsTable).where(eq(peerTagAssignmentsTable.peerId, peer.id)).run();
				tx.delete(policyGrantsTable).where(eq(policyGrantsTable.srcPeerId, peer.id)).run();
				tx.delete(policyGrantsTable).where(eq(policyGrantsTable.dstPeerId, peer.id)).run();
				tx.update(peersTable).set({ exitPeerId: null }).where(eq(peersTable.exitPeerId, peer.id)).run();
				tx.delete(peersTable).where(eq(peersTable.id, params.peerId)).run();
			});
			log.info(`Deleted peer ${peer.id} from server ${server.id}`);
			const convergeResult = await converge(server.id);
			if (!convergeResult.ok) {
				log.warn(`Peer ${peer.id} deleted but server ${server.id} failed to converge: ${convergeResult.reason}`);
			}

			return { success: true, unassignedExitClients: dependents.map((p) => ({ id: p.id, friendlyName: p.friendlyName, wgAddress: p.wgAddress })) };
		},
		{
			params: t.Object({
				id: t.String(),
				peerId: t.String(),
			}),
			verifyAuth: { scope: 'server' },
		}
	);
