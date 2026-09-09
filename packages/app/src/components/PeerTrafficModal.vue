<template>
	<BaseModal :visible="visible" @update:visible="$emit('update:visible', $event)" :header="peer ? `${peer.friendlyName ?? peer.id} / traffic` : 'traffic'">
		<template v-if="peer">
			<TrafficCard :buckets="traffic?.buckets ?? []" :resolution="resolution" @update:resolution="resolution = $event" :enabled="traffic?.enabled" />

			<div class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm text-muted mt-4">
				<span class="whitespace-nowrap">since</span>
				<span class="text-text text-right">{{ new Date(peer.statsSince).toLocaleString() }}</span>

				<span class="whitespace-nowrap">lifetime total</span>
				<span class="text-text text-right">&darr; {{ formatBytes(peer.lifetimeRxBytes) }} &uarr; {{ formatBytes(peer.lifetimeTxBytes) }}</span>
			</div>
		</template>

		<template #footer>
			<BaseButton @click="reset" variant="danger" size="sm">reset counters</BaseButton>
		</template>
	</BaseModal>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { queryPeerTraffic, type TrafficResolution } from '@app/queries/queryTraffic';
import { invalidate } from '@app/queries/keys';
import { api } from '@app/queries/edenClient';
import { formatBytes } from '@app/lib/format';
import BaseModal from './BaseModal.vue';
import BaseButton from './BaseButton.vue';
import TrafficCard from './TrafficCard.vue';

const props = defineProps<{
	visible: boolean;
	serverId: string;
	peer: { id: string; friendlyName: string | null; lifetimeRxBytes: number; lifetimeTxBytes: number; statsSince: string | Date } | null;
}>();

defineEmits<{ 'update:visible': [boolean] }>();

const resolution = ref<TrafficResolution>('1m');

const { data: traffic } = useQuery(
	computed(() => ({
		...queryPeerTraffic(props.serverId, props.peer?.id ?? '', resolution.value),
		enabled: props.visible && !!props.peer,
	}))
);

const queryClient = useQueryClient();

const reset = async () => {
	if (!props.peer) return;
	if (!confirm(`Reset lifetime traffic counters for ${props.peer.friendlyName ?? props.peer.id}?`)) return;

	await api.wg.servers({ id: props.serverId }).peers({ peerId: props.peer.id }).traffic.reset.post();
	// also invalidates this peer's traffic buckets at every resolution, so the chart shown
	// in this same modal refreshes immediately instead of waiting for the 30s poll
	await invalidate.afterPeerTrafficReset(queryClient, props.serverId, props.peer.id);
};
</script>
