import { queryOptions } from '@tanstack/vue-query';
import { api } from './edenClient';
import { queryKeys } from './keys';

export const queryServers = () =>
	queryOptions({
		queryKey: queryKeys.serverList(),
		queryFn: async () => {
			const resp = await api.wg.servers.get();
			return resp.data ?? [];
		},
	});

export const queryServer = (id: string) =>
	queryOptions({
		queryKey: queryKeys.server(id),
		queryFn: async () => {
			const resp = await api.wg.servers({ id: id }).get();
			return resp.data;
		},
	});

export const queryServerPeers = (id: string) =>
	queryOptions({
		queryKey: queryKeys.serverPeers(id),
		queryFn: async () => {
			const resp = await api.wg.servers({ id: id }).peers.get();
			return resp.data;
		},
		refetchInterval: 5000,
	});
