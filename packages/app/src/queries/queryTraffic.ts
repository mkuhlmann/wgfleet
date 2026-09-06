import { queryOptions } from '@tanstack/vue-query';
import { api } from './edenClient';

export type TrafficResolution = '1m' | '1h' | '1d';

export const queryServerTraffic = (id: string, resolution: TrafficResolution) =>
	queryOptions({
		queryKey: ['serverTraffic', id, resolution],
		queryFn: async () => {
			const resp = await api.wg.servers({ id: id }).traffic.get({ query: { resolution } });
			return resp.data;
		},
		// matches the server's ~30s sample cadence - no value polling faster
		refetchInterval: 30000,
	});

export const queryPeerTraffic = (id: string, peerId: string, resolution: TrafficResolution) =>
	queryOptions({
		queryKey: ['peerTraffic', id, peerId, resolution],
		queryFn: async () => {
			const resp = await api.wg.servers({ id: id }).peers({ peerId: peerId }).traffic.get({ query: { resolution } });
			return resp.data;
		},
		refetchInterval: 30000,
	});
