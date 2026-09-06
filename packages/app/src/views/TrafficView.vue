<template>
	<div class="flex flex-col gap-8">
		<div class="text-xs text-muted" v-if="isLoading">loading server... <span class="caret"></span></div>

		<div class="flex flex-col gap-4" v-if="server">
			<div class="flex items-center justify-between flex-wrap gap-3">
				<h1 class="text-lg font-bold text-text">
					<span class="text-accent-dim">///</span> {{ server.friendlyName ?? server.id }} <span class="text-muted">/ traffic</span>
				</h1>
				<BaseButton :as="'router-link'" :to="{ name: 'servers-detail', params: { id: server.id } }" variant="ghost">&laquo; back to server</BaseButton>
			</div>

			<div class="flex flex-wrap items-start justify-between gap-4">
				<BaseCard title="lifetime total" class="max-w-md flex-1 min-w-[260px]">
					<div class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm text-muted">
						<span class="whitespace-nowrap">since</span>
						<span class="text-text text-right">{{ new Date(server.statsSince).toLocaleString() }}</span>

						<span class="whitespace-nowrap">received</span>
						<span class="text-text text-right">{{ formatBytes(server.lifetimeRxBytes) }}</span>

						<span class="whitespace-nowrap">transmitted</span>
						<span class="text-text text-right">{{ formatBytes(server.lifetimeTxBytes) }}</span>
					</div>

					<template #footer>
						<BaseButton @click="resetServer" variant="danger" size="sm" class="w-full">reset counters</BaseButton>
					</template>
				</BaseCard>

				<div class="flex gap-2">
					<BaseButton
						v-for="option in rangeOptions"
						:key="option.resolution"
						@click="resolution = option.resolution"
						:variant="resolution === option.resolution ? 'primary' : 'secondary'"
						size="sm"
					>
						{{ option.label }}
					</BaseButton>
				</div>
			</div>

			<div v-if="serverTraffic?.enabled === false" class="text-sm text-muted border border-border rounded-sm p-6 text-center">traffic statistics disabled</div>
			<BaseTrafficChart v-else size="full" :buckets="serverTraffic?.buckets ?? []" />
		</div>

		<div class="rule-line"></div>

		<div class="flex flex-col gap-4" v-if="peers && peers.length">
			<h2 class="text-base font-bold text-text"><span class="text-accent-dim">///</span> peers</h2>

			<div class="grid gap-4 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
				<TrafficPeerCard v-for="peer in peers" :key="peer.id" :server-id="server!.id" :peer="peer" :resolution="resolution" />
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { queryServer, queryServerPeers } from '@app/queries/queryServers';
import { queryServerTraffic, type TrafficResolution } from '@app/queries/queryTraffic';
import { api } from '@app/queries/edenClient';
import { formatBytes } from '@app/lib/format';
import BaseButton from '@app/components/BaseButton.vue';
import BaseCard from '@app/components/BaseCard.vue';
import BaseTrafficChart from '@app/components/BaseTrafficChart.vue';
import TrafficPeerCard from '@app/components/TrafficPeerCard.vue';

const route = useRoute();
const serverId = route.params.id as string;

const { data: server, isLoading } = useQuery(queryServer(serverId));
const { data: peers } = useQuery(queryServerPeers(serverId));

const rangeOptions: { label: string; resolution: TrafficResolution }[] = [
	{ label: '24h', resolution: '1m' },
	{ label: '30d', resolution: '1h' },
	{ label: '1y', resolution: '1d' },
];
const resolution = ref<TrafficResolution>('1m');

const { data: serverTraffic } = useQuery(computed(() => queryServerTraffic(serverId, resolution.value)));

const queryClient = useQueryClient();

const resetServer = async () => {
	if (!confirm('Reset lifetime traffic counters for this server?')) return;
	await api.wg.servers({ id: serverId }).traffic.reset.post();
	await queryClient.invalidateQueries(queryServer(serverId));
};
</script>
