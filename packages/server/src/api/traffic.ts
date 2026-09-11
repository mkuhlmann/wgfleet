import { Elysia, t } from 'elysia';
import { db } from '../db';
import { peersTable, serverPeersTable, trafficBucketsTable } from '../db/schema';
import { eq, and, asc, sql } from 'drizzle-orm';
import { auth } from './auth';
import { trafficStatsEnabled } from '../wg/traffic';

const resolutionSchema = t.Union([t.Literal('1m'), t.Literal('1h'), t.Literal('1d')]);

export const trafficRoutes = new Elysia()
	.use(auth)
	.get(
		'/wg/servers/:id/traffic',
		async ({ wgServer: server, query }) => {
			// Server-level series is a derived SUM over its peers' buckets - there is no separate
			// server-level bucket table (see db/schema.ts's trafficBucketsTable comment).
			const buckets = await db
				.select({
					bucketStart: trafficBucketsTable.bucketStart,
					rxBytes: sql<number>`sum(${trafficBucketsTable.rxBytes})`,
					txBytes: sql<number>`sum(${trafficBucketsTable.txBytes})`,
				})
				.from(trafficBucketsTable)
				.where(and(eq(trafficBucketsTable.serverPeerId, server.id), eq(trafficBucketsTable.resolution, query.resolution)))
				.groupBy(trafficBucketsTable.bucketStart)
				.orderBy(asc(trafficBucketsTable.bucketStart));

			return { enabled: trafficStatsEnabled, resolution: query.resolution, buckets };
		},
		{
			params: t.Object({ id: t.String() }),
			query: t.Object({ resolution: resolutionSchema }),
			serverScope: true,
		}
	)
	.get(
		'/wg/servers/:id/peers/:peerId/traffic',
		async ({ peer, query }) => {
			const buckets = await db
				.select({ bucketStart: trafficBucketsTable.bucketStart, rxBytes: trafficBucketsTable.rxBytes, txBytes: trafficBucketsTable.txBytes })
				.from(trafficBucketsTable)
				.where(and(eq(trafficBucketsTable.peerId, peer.id), eq(trafficBucketsTable.resolution, query.resolution)))
				.orderBy(asc(trafficBucketsTable.bucketStart));

			return { enabled: trafficStatsEnabled, resolution: query.resolution, buckets };
		},
		{
			params: t.Object({ id: t.String(), peerId: t.String() }),
			query: t.Object({ resolution: resolutionSchema }),
			serverPeerScope: true,
		}
	)
	.post(
		'/wg/servers/:id/traffic/reset',
		async ({ wgServer: server }) => {
			await db.update(serverPeersTable).set({ lifetimeRxBytes: 0, lifetimeTxBytes: 0, statsSince: new Date() }).where(eq(serverPeersTable.id, server.id));

			return { success: true };
		},
		{
			params: t.Object({ id: t.String() }),
			serverScope: true,
		}
	)
	.post(
		'/wg/servers/:id/peers/:peerId/traffic/reset',
		async ({ peer }) => {
			await db.update(peersTable).set({ lifetimeRxBytes: 0, lifetimeTxBytes: 0, statsSince: new Date() }).where(eq(peersTable.id, peer.id));

			return { success: true };
		},
		{
			params: t.Object({ id: t.String(), peerId: t.String() }),
			serverPeerScope: true,
		}
	);
