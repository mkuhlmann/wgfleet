<template>
	<BaseCard :title="peer.friendlyName ?? peer.id" class="h-full flex flex-col gap-3">
		<div v-if="traffic?.enabled === false" class="text-xs text-muted">traffic statistics disabled</div>
		<BaseTrafficChart v-else size="sparkline" :buckets="traffic?.buckets ?? []" />

		<div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted">
			<span class="whitespace-nowrap">since</span>
			<span class="text-text text-right">{{ new Date(peer.statsSince).toLocaleDateString() }}</span>

			<span class="whitespace-nowrap">total</span>
			<span class="text-text text-right">&darr; {{ formatBytes(peer.lifetimeRxBytes) }} &uarr; {{ formatBytes(peer.lifetimeTxBytes) }}</span>
		</div>

		<template #footer>
			<BaseButton @click="reset" variant="danger" size="sm" class="w-full">reset counters</BaseButton>
		</template>
	</BaseCard>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { queryPeerTraffic, type TrafficResolution } from '@app/queries/queryTraffic';
import { queryServerPeers } from '@app/queries/queryServers';
import { api } from '@app/queries/edenClient';
import { formatBytes } from '@app/lib/format';
import BaseCard from './BaseCard.vue';
import BaseButton from './BaseButton.vue';
import BaseTrafficChart from './BaseTrafficChart.vue';

const props = defineProps<{
	serverId: string;
	peer: { id: string; friendlyName: string | null; lifetimeRxBytes: number; lifetimeTxBytes: number; statsSince: string | Date };
	resolution: TrafficResolution;
}>();

const { data: traffic } = useQuery(computed(() => queryPeerTraffic(props.serverId, props.peer.id, props.resolution)));

const queryClient = useQueryClient();

const reset = async () => {
	if (!confirm(`Reset lifetime traffic counters for ${props.peer.friendlyName ?? props.peer.id}?`)) return;
	await api.wg.servers({ id: props.serverId }).peers({ peerId: props.peer.id }).traffic.reset.post();
	await queryClient.invalidateQueries(queryServerPeers(props.serverId));
};
</script>
