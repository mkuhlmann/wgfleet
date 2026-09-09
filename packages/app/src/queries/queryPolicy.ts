import { queryOptions } from '@tanstack/vue-query';
import { api } from './edenClient';
import { queryKeys } from './keys';

export const queryServerTags = (id: string) =>
	queryOptions({
		queryKey: queryKeys.serverTags(id),
		queryFn: async () => {
			const resp = await api.wg.servers({ id: id }).tags.get();
			return resp.data ?? [];
		},
	});

export const queryServerGrants = (id: string) =>
	queryOptions({
		queryKey: queryKeys.serverGrants(id),
		queryFn: async () => {
			const resp = await api.wg.servers({ id: id }).grants.get();
			return resp.data ?? [];
		},
	});

export const queryServerPolicy = (id: string) =>
	queryOptions({
		queryKey: queryKeys.serverPolicy(id),
		queryFn: async () => {
			const resp = await api.wg.servers({ id: id }).policy.get();
			return resp.data ?? { tags: [], grants: [], peerTags: [] };
		},
	});
