import { queryOptions } from '@tanstack/vue-query';
import { api } from './edenClient';

export const queryServerTags = (id: string) =>
	queryOptions({
		queryKey: ['serverTags', id],
		queryFn: async () => {
			const resp = await api.wg.servers({ id: id }).tags.get();
			return resp.data ?? [];
		},
	});

export const queryServerGrants = (id: string) =>
	queryOptions({
		queryKey: ['serverGrants', id],
		queryFn: async () => {
			const resp = await api.wg.servers({ id: id }).grants.get();
			return resp.data ?? [];
		},
	});

export const queryServerPolicy = (id: string) =>
	queryOptions({
		queryKey: ['serverPolicy', id],
		queryFn: async () => {
			const resp = await api.wg.servers({ id: id }).policy.get();
			return resp.data ?? { tags: [], grants: [], peerTags: [] };
		},
	});
