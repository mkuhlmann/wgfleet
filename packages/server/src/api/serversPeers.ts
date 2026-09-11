import { Elysia, status, t } from 'elysia';
import { db } from '../db';
import { peerTagAssignmentsTable, peerTagsTable, peersTable, policyGrantsTable, type Peer, type ServerPeer } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { wgDerivePublicKey, wgGenKey, wgGenPsk } from '../wg/shell';
import { converge } from '../wg/converge';
import { wgManager } from '../wg/manager';
import { resolvePeerWrite } from '../wg/peerIntake';
import { policyGraphOf, tagIdsByPeer } from '@server/db/policyGraph';
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

async function setPeerTags(peerId: string, tagIds: string[]) {
	db.transaction((tx) => {
		tx.delete(peerTagAssignmentsTable).where(eq(peerTagAssignmentsTable.peerId, peerId)).run();
		for (const tagId of tagIds) {
			tx.insert(peerTagAssignmentsTable).values({ peerId, tagId }).run();
		}
	});
}

// Every column a peer write may set. One schema for both POST and PATCH - they used to carry
// byte-identical copies, comments included. `undefined` leaves a field alone (so PATCH is a
// genuine partial update), `null` clears the nullable ones.
const PEER_WRITE_BODY = t.Object({
	friendlyName: t.Optional(t.String()),
	wgAddress: t.Optional(t.String()),
	tagIds: t.Optional(t.Array(t.String())),
	isExitNode: t.Optional(t.Boolean()),
	exitPeerId: t.Optional(t.Nullable(t.String())),
	exitDns: t.Optional(t.Nullable(t.String())),
	// comma-separated ipv4 CIDR list of LANs behind this peer, e.g.
	// "192.168.1.0/24,10.10.0.0/16". A plain string rather than an array so the wire shape
	// matches the column and the peer row this endpoint returns; entries are validated,
	// network-aligned and overlap-checked in wg/peerIntake.ts.
	advertisedRoutes: t.Optional(t.Nullable(t.String())),
});

export const serversPeersRoute = new Elysia()
	.use(auth)
	.get(
		'/wg/servers/:id/peers',
		async ({ wgServer }) => {
			const graph = await policyGraphOf(wgServer);
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
			serverScope: true,
		}
	)
	.post(
		'/wg/servers/:id/peers',
		async ({ wgServer: server, body }) => {
			const resolved = await resolvePeerWrite(server, null, body);
			if (!resolved.ok) return status(400, resolved.message);
			const values = resolved.values;

			const privateKey = await wgGenKey();
			const publicKey = await wgDerivePublicKey(privateKey);

			const peer = await db
				.insert(peersTable)
				.values({
					serverPeerId: server.id,
					friendlyName: values.friendlyName,

					wgPrivateKey: privateKey,
					wgPublicKey: publicKey,
					wgPresharedKey: await wgGenPsk(),

					wgAddress: values.wgAddress,

					isExitNode: values.isExitNode,
					exitPeerId: values.exitPeerId,
					exitDns: values.exitDns,
					advertisedRoutes: values.advertisedRoutes,

					// the column default is a literal 0 (epoch) - see schema.ts's statsSince comment
					statsSince: new Date(),
				})
				.returning();

			if (values.tagIds?.length) {
				await setPeerTags(peer[0].id, values.tagIds);
			}

			log.info(`Created peer ${peer[0].id} on server ${server.id}`);
			const convergeResult = await converge(server.id);
			if (!convergeResult.ok) {
				log.warn(`Peer ${peer[0].id} created but server ${server.id} failed to converge: ${convergeResult.reason}`);
			}

			return { ...peer[0], tagIds: values.tagIds ?? [] };
		},
		{
			body: PEER_WRITE_BODY,
			params: t.Object({
				id: t.String(),
			}),
			serverScope: true,
		}
	)
	.patch(
		'/wg/servers/:id/peers/:peerId',
		async ({ wgServer: server, peer, params, body }) => {
			const resolved = await resolvePeerWrite(server, peer, body);
			if (!resolved.ok) return status(400, resolved.message);
			const values = resolved.values;

			const updatedPeer = await db
				.update(peersTable)
				.set({
					friendlyName: values.friendlyName,
					wgAddress: values.wgAddress,
					isExitNode: values.isExitNode,
					exitPeerId: values.exitPeerId,
					exitDns: values.exitDns,
					advertisedRoutes: values.advertisedRoutes,
				})
				.where(and(eq(peersTable.id, params.peerId), eq(peersTable.serverPeerId, server.id)))
				.returning();

			// undefined = leave tags unchanged, [] = explicitly clear all tags (unrestrict)
			if (values.tagIds !== undefined) {
				await setPeerTags(peer.id, values.tagIds);
			}

			log.info(`Updated peer ${peer.id} on server ${server.id}`);
			const convergeResult = await converge(server.id);
			if (!convergeResult.ok) {
				log.warn(`Peer ${peer.id} updated but server ${server.id} failed to converge: ${convergeResult.reason}`);
			}

			return updatedPeer;
		},
		{
			body: PEER_WRITE_BODY,
			params: t.Object({
				id: t.String(),
				peerId: t.String(),
			}),
			serverPeerScope: true,
		}
	)
	.get(
		'/wg/servers/:id/peers/:peerId/config',
		async ({ peer, query }) => {
			return generatePeerConfig(peer, { exit: query.exit, nat: query.nat });
		},
		{
			params: t.Object({
				id: t.String(),
				peerId: t.String(),
			}),
			query: PEER_CONFIG_QUERY,
			serverPeerScope: true,
		}
	)
	.delete(
		'/wg/servers/:id/peers/:peerId',
		async ({ wgServer: server, peer, params }) => {
			// no db-level FK enforcement (sqlite foreign_keys pragma isn't turned on anywhere in
			// this codebase), so cascade cleanup happens explicitly here - a peer-scoped grant
			// naming this peer directly would otherwise dangle.
			// Deleting an exit node outright is allowed (unlike merely unmarking it, which is
			// rejected while dependents exist - see lib/peerInvariants.ts): the peer is gone,
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
			serverPeerScope: true,
		}
	);
