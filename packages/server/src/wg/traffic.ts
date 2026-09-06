import { db } from '@server/db';
import { peersTable, serverPeersTable, trafficBucketsTable, type ServerPeer } from '@server/db/schema';
import { and, eq, lt, sql } from 'drizzle-orm';

// Set WG_TRAFFIC_STATS_ENABLED=false (or "0") to disable traffic-graph collection entirely -
// mirrors the WG_DEV_SHIM override pattern in wg/shell.ts. Default is enabled. Turning this off
// stops new samples/rollups from being written but never deletes what's already there; turning
// it back on resumes from wherever the last sample left off.
const override = (process.env.WG_TRAFFIC_STATS_ENABLED ?? '').toLowerCase();
export const trafficStatsEnabled = override !== 'false' && override !== '0';

export const RESOLUTIONS = ['1m', '1h', '1d'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;
const FOUR_HUNDRED_DAYS_MS = 400 * ONE_DAY_MS;

const RESOLUTION_MS: Record<Resolution, number> = {
	'1m': 60 * 1000,
	'1h': 60 * 60 * 1000,
	'1d': ONE_DAY_MS,
};

// Floors `at` to the start of its bucket for `resolution` (UTC-aligned, since unix-epoch math is
// naturally UTC - no DST edge cases to worry about).
export const bucketStartFor = (at: Date, resolution: Resolution): Date => {
	const size = RESOLUTION_MS[resolution];
	return new Date(Math.floor(at.getTime() / size) * size);
};

// hasPriorSample=false (never sampled yet) and current<previous (the wg interface's cumulative
// counter went backwards - it restarted) both yield a delta of 0 for this tick, never a spike or
// a negative number. The next tick establishes a fresh baseline either way.
export const computeCounterDelta = (hasPriorSample: boolean, previous: number, current: number): number => {
	if (!hasPriorSample || current < previous) return 0;
	return current - previous;
};

export const computePeerDelta = (
	prior: { hasPriorSample: boolean; wgLastRxBytes: number; wgLastTxBytes: number },
	sample: { transferRx: number; transferTx: number }
): { rxDelta: number; txDelta: number } => ({
	rxDelta: computeCounterDelta(prior.hasPriorSample, prior.wgLastRxBytes, sample.transferRx),
	txDelta: computeCounterDelta(prior.hasPriorSample, prior.wgLastTxBytes, sample.transferTx),
});

export type WgPeerSample = { publicKey: string; transferRx: number; transferTx: number };

/**
 * Records one collection tick's worth of samples for one server: computes each peer's rx/tx
 * delta since its last sample, updates lifetime totals on the peer and the server, and
 * accumulates the deltas into the current 1-minute bucket. Takes samples as plain data (the
 * caller - wg/manager.ts - already called wgShow once for peerInfo) rather than calling wgShow
 * itself, so this stays testable without touching the shared wg/shell mock.
 */
export const recordServerTraffic = async (server: ServerPeer, samples: WgPeerSample[], now: Date = new Date()): Promise<void> => {
	if (samples.length === 0) return;

	const peers = await db.query.peersTable.findMany({ where: eq(peersTable.serverPeerId, server.id) });
	const peerByPublicKey = new Map(peers.map((p) => [p.wgPublicKey, p]));
	const bucketStart = bucketStartFor(now, '1m');

	let serverRxDelta = 0;
	let serverTxDelta = 0;

	db.transaction((tx) => {
		for (const sample of samples) {
			// wg knows a pubkey the db doesn't (stale/manually-added peer) - ignore it, same as
			// firewall.ts's handling of unresolvable references.
			const peer = peerByPublicKey.get(sample.publicKey);
			if (!peer) continue;

			const { rxDelta, txDelta } = computePeerDelta({ hasPriorSample: peer.wgLastSampledAt !== null, wgLastRxBytes: peer.wgLastRxBytes, wgLastTxBytes: peer.wgLastTxBytes }, sample);

			tx.update(peersTable)
				.set({
					wgLastRxBytes: sample.transferRx,
					wgLastTxBytes: sample.transferTx,
					wgLastSampledAt: now,
					lifetimeRxBytes: sql`${peersTable.lifetimeRxBytes} + ${rxDelta}`,
					lifetimeTxBytes: sql`${peersTable.lifetimeTxBytes} + ${txDelta}`,
				})
				.where(eq(peersTable.id, peer.id))
				.run();

			if (rxDelta > 0 || txDelta > 0) {
				tx.insert(trafficBucketsTable)
					.values({ peerId: peer.id, serverPeerId: server.id, resolution: '1m', bucketStart, rxBytes: rxDelta, txBytes: txDelta })
					.onConflictDoUpdate({
						target: [trafficBucketsTable.peerId, trafficBucketsTable.resolution, trafficBucketsTable.bucketStart],
						set: { rxBytes: sql`${trafficBucketsTable.rxBytes} + ${rxDelta}`, txBytes: sql`${trafficBucketsTable.txBytes} + ${txDelta}` },
					})
					.run();
			}

			serverRxDelta += rxDelta;
			serverTxDelta += txDelta;
		}

		if (serverRxDelta > 0 || serverTxDelta > 0) {
			tx.update(serverPeersTable)
				.set({
					lifetimeRxBytes: sql`${serverPeersTable.lifetimeRxBytes} + ${serverRxDelta}`,
					lifetimeTxBytes: sql`${serverPeersTable.lifetimeTxBytes} + ${serverTxDelta}`,
				})
				.where(eq(serverPeersTable.id, server.id))
				.run();
		}
	});
};

export type BucketRow = { peerId: string; serverPeerId: string; bucketStart: Date; rxBytes: number; txBytes: number };

// Pure - groups already-selected rows (rows from the finer resolution older than its retention
// window) into their coarser-resolution bucket. Drives both 1m->1h and 1h->1d rollups - only
// targetResolution differs between the two calls.
export const consolidateBuckets = (rows: BucketRow[], targetResolution: Resolution): BucketRow[] => {
	const grouped = new Map<string, BucketRow>();

	for (const row of rows) {
		const bucketStart = bucketStartFor(row.bucketStart, targetResolution);
		const key = `${row.peerId}:${bucketStart.getTime()}`;
		const existing = grouped.get(key);
		if (existing) {
			existing.rxBytes += row.rxBytes;
			existing.txBytes += row.txBytes;
		} else {
			grouped.set(key, { peerId: row.peerId, serverPeerId: row.serverPeerId, bucketStart, rxBytes: row.rxBytes, txBytes: row.txBytes });
		}
	}

	return [...grouped.values()];
};

const rollupResolution = async (from: Resolution, to: Resolution, now: Date, windowMs: number): Promise<void> => {
	const cutoff = new Date(now.getTime() - windowMs);
	const rows = await db.select().from(trafficBucketsTable).where(and(eq(trafficBucketsTable.resolution, from), lt(trafficBucketsTable.bucketStart, cutoff)));
	if (rows.length === 0) return;

	const consolidated = consolidateBuckets(rows, to);

	db.transaction((tx) => {
		for (const row of consolidated) {
			tx.insert(trafficBucketsTable)
				.values({ peerId: row.peerId, serverPeerId: row.serverPeerId, resolution: to, bucketStart: row.bucketStart, rxBytes: row.rxBytes, txBytes: row.txBytes })
				.onConflictDoUpdate({
					target: [trafficBucketsTable.peerId, trafficBucketsTable.resolution, trafficBucketsTable.bucketStart],
					set: { rxBytes: sql`${trafficBucketsTable.rxBytes} + ${row.rxBytes}`, txBytes: sql`${trafficBucketsTable.txBytes} + ${row.txBytes}` },
				})
				.run();
		}

		tx.delete(trafficBucketsTable)
			.where(and(eq(trafficBucketsTable.resolution, from), lt(trafficBucketsTable.bucketStart, cutoff)))
			.run();
	});
};

const pruneResolution = async (resolution: Resolution, now: Date, windowMs: number): Promise<void> => {
	const cutoff = new Date(now.getTime() - windowMs);
	await db.delete(trafficBucketsTable).where(and(eq(trafficBucketsTable.resolution, resolution), lt(trafficBucketsTable.bucketStart, cutoff)));
};

/**
 * Consolidates 1m rows older than ~24h into 1h, 1h rows older than ~30d into 1d, then hard-
 * deletes 1d rows older than ~400d. Keeps trafficBuckets bounded to roughly 2,560 rows/peer
 * forever, regardless of uptime. `now` is a parameter (not Date.now()) so tests can simulate
 * "N days later" without real sleeps.
 */
export const rollupAndPrune = async (now: Date = new Date()): Promise<void> => {
	await rollupResolution('1m', '1h', now, ONE_DAY_MS);
	await rollupResolution('1h', '1d', now, THIRTY_DAYS_MS);
	await pruneResolution('1d', now, FOUR_HUNDRED_DAYS_MS);
};
