import { describe, expect, it } from 'bun:test';
import { bucketStartFor, computeCounterDelta, computePeerDelta, consolidateBuckets, type BucketRow } from './traffic';

describe('bucketStartFor', () => {
	it('floors to the start of the minute for 1m', () => {
		expect(bucketStartFor(new Date('2026-01-01T00:00:45.500Z'), '1m')).toEqual(new Date('2026-01-01T00:00:00.000Z'));
	});

	it('floors to the start of the hour for 1h', () => {
		expect(bucketStartFor(new Date('2026-01-01T05:42:10.000Z'), '1h')).toEqual(new Date('2026-01-01T05:00:00.000Z'));
	});

	it('floors to the start of the day for 1d', () => {
		expect(bucketStartFor(new Date('2026-01-01T23:59:59.000Z'), '1d')).toEqual(new Date('2026-01-01T00:00:00.000Z'));
	});
});

describe('computeCounterDelta', () => {
	it('is 0 when there is no prior sample yet', () => {
		expect(computeCounterDelta(false, 0, 12345)).toBe(0);
	});

	it('is the difference when the counter only moved forward', () => {
		expect(computeCounterDelta(true, 1000, 1500)).toBe(500);
	});

	it('is 0 (not negative) when the counter went backwards - interface restarted', () => {
		expect(computeCounterDelta(true, 5000, 200)).toBe(0);
	});

	it('is 0 when the counter is unchanged', () => {
		expect(computeCounterDelta(true, 1000, 1000)).toBe(0);
	});
});

describe('computePeerDelta', () => {
	it('computes rx/tx deltas independently', () => {
		const result = computePeerDelta({ hasPriorSample: true, wgLastRxBytes: 100, wgLastTxBytes: 900 }, { transferRx: 150, transferTx: 200 });
		expect(result).toEqual({ rxDelta: 50, txDelta: 0 });
	});

	it('treats a never-sampled peer as a zero-delta baseline tick', () => {
		const result = computePeerDelta({ hasPriorSample: false, wgLastRxBytes: 0, wgLastTxBytes: 0 }, { transferRx: 42, transferTx: 7 });
		expect(result).toEqual({ rxDelta: 0, txDelta: 0 });
	});
});

describe('consolidateBuckets', () => {
	const row = (overrides: Partial<BucketRow> & Pick<BucketRow, 'peerId' | 'bucketStart'>): BucketRow => ({
		serverPeerId: 'server-1',
		rxBytes: 0,
		txBytes: 0,
		...overrides,
	});

	it('sums rows from the same peer that fall into the same coarser bucket', () => {
		const rows = [
			row({ peerId: 'peer-1', bucketStart: new Date('2026-01-01T05:00:00.000Z'), rxBytes: 10, txBytes: 1 }),
			row({ peerId: 'peer-1', bucketStart: new Date('2026-01-01T05:30:00.000Z'), rxBytes: 20, txBytes: 2 }),
		];

		const result = consolidateBuckets(rows, '1h');

		expect(result).toEqual([{ peerId: 'peer-1', serverPeerId: 'server-1', bucketStart: new Date('2026-01-01T05:00:00.000Z'), rxBytes: 30, txBytes: 3 }]);
	});

	it('keeps different peers and different coarser buckets separate', () => {
		const rows = [
			row({ peerId: 'peer-1', bucketStart: new Date('2026-01-01T05:10:00.000Z'), rxBytes: 10, txBytes: 1 }),
			row({ peerId: 'peer-2', bucketStart: new Date('2026-01-01T05:10:00.000Z'), rxBytes: 20, txBytes: 2 }),
			row({ peerId: 'peer-1', bucketStart: new Date('2026-01-01T06:10:00.000Z'), rxBytes: 30, txBytes: 3 }),
		];

		const result = consolidateBuckets(rows, '1h');

		expect(result).toHaveLength(3);
		expect(result).toContainEqual({ peerId: 'peer-1', serverPeerId: 'server-1', bucketStart: new Date('2026-01-01T05:00:00.000Z'), rxBytes: 10, txBytes: 1 });
		expect(result).toContainEqual({ peerId: 'peer-2', serverPeerId: 'server-1', bucketStart: new Date('2026-01-01T05:00:00.000Z'), rxBytes: 20, txBytes: 2 });
		expect(result).toContainEqual({ peerId: 'peer-1', serverPeerId: 'server-1', bucketStart: new Date('2026-01-01T06:00:00.000Z'), rxBytes: 30, txBytes: 3 });
	});
});
