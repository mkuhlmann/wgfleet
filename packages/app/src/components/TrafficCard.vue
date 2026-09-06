<template>
	<BaseCard :title="title" class="flex flex-col">
		<template #actions>
			<div class="flex gap-1.5">
				<BaseButton
					v-for="option in rangeOptions"
					:key="option.resolution"
					@click="$emit('update:resolution', option.resolution)"
					:variant="resolution === option.resolution ? 'primary' : 'secondary'"
					size="sm"
				>
					{{ option.label }}
				</BaseButton>
			</div>
		</template>

		<div v-if="enabled === false" class="text-sm text-muted text-center py-6">traffic statistics disabled</div>

		<div v-else class="flex items-stretch gap-4">
			<div class="flex-1 min-w-0">
				<TrafficChart :buckets="buckets" />
			</div>
			<div class="flex flex-col justify-between shrink-0 text-right text-sm">
				<div class="text-accent">&darr; {{ formatBytes(totals.rx) }}</div>
				<div class="text-muted">&uarr; {{ formatBytes(totals.tx) }}</div>
			</div>
		</div>

		<div v-if="enabled !== false" class="flex gap-4 text-xs mt-2">
			<span class="text-accent">[ rx ]</span>
			<span class="text-muted">[ tx ]</span>
		</div>
	</BaseCard>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import BaseCard from './BaseCard.vue';
import BaseButton from './BaseButton.vue';
import TrafficChart from './TrafficChart.vue';
import { formatBytes } from '@app/lib/format';
import { sumBuckets, type TrafficBucket } from '@app/lib/traffic';
import type { TrafficResolution } from '@app/queries/queryTraffic';

const props = withDefaults(
	defineProps<{
		buckets: TrafficBucket[];
		resolution: TrafficResolution;
		enabled?: boolean;
		title?: string;
	}>(),
	{
		title: 'traffic',
	}
);

defineEmits<{ 'update:resolution': [TrafficResolution] }>();

const rangeOptions: { label: string; resolution: TrafficResolution }[] = [
	{ label: '24h', resolution: '1m' },
	{ label: '30d', resolution: '1h' },
	{ label: '1y', resolution: '1d' },
];

const totals = computed(() => sumBuckets(props.buckets));
</script>
