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

		<template v-else>
			<TrafficChart :buckets="buckets" />

			<div class="flex gap-4 text-xs mt-2">
				<span class="text-accent">[ rx ] &darr; {{ formatBytes(totals.rx) }}</span>
				<span class="text-muted">[ tx ] &uarr; {{ formatBytes(totals.tx) }}</span>
			</div>
		</template>
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
