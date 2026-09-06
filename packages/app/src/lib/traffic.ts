export type TrafficBucket = { bucketStart: string | number | Date; rxBytes: number; txBytes: number };

export const sumBuckets = (buckets: TrafficBucket[]): { rx: number; tx: number } =>
	buckets.reduce((acc, b) => ({ rx: acc.rx + b.rxBytes, tx: acc.tx + b.txBytes }), { rx: 0, tx: 0 });
