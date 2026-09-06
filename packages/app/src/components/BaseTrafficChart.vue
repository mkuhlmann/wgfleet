<template>
	<div class="flex flex-col gap-1.5">
		<div v-if="buckets.length === 0" class="flex items-center justify-center text-muted text-xs border border-border rounded-sm" :style="{ height: `${chartHeight}px` }">
			no data yet
		</div>

		<template v-else>
			<svg :viewBox="`0 0 ${Math.max(buckets.length, 1)} 100`" preserveAspectRatio="none" :style="{ height: `${chartHeight}px`, width: '100%' }">
				<line x1="0" y1="50" :x2="buckets.length" y2="50" stroke="var(--color-border)" stroke-width="0.5" vector-effect="non-scaling-stroke" />

				<g v-for="(bucket, i) in buckets" :key="i">
					<title>{{ formatTime(bucket.bucketStart) }} — rx {{ formatBytes(bucket.rxBytes) }}, tx {{ formatBytes(bucket.txBytes) }}</title>
					<rect :x="i + 0.1" :y="50 - rxHeight(bucket)" width="0.8" :height="rxHeight(bucket)" fill="var(--color-accent)" />
					<rect :x="i + 0.1" y="50" width="0.8" :height="txHeight(bucket)" fill="var(--color-muted)" />
				</g>
			</svg>

			<template v-if="size === 'full'">
				<div class="flex justify-between text-[0.65rem] text-muted">
					<span>{{ formatTime(buckets[0].bucketStart) }}</span>
					<span>{{ formatTime(buckets[buckets.length - 1].bucketStart) }}</span>
				</div>
				<div class="flex gap-4 text-xs">
					<span class="text-accent">[ rx ]</span>
					<span class="text-muted">[ tx ]</span>
				</div>
			</template>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatBytes } from '@app/lib/format';

type TrafficBucket = { bucketStart: string | number | Date; rxBytes: number; txBytes: number };

const props = withDefaults(
	defineProps<{
		buckets: TrafficBucket[];
		size?: 'full' | 'sparkline';
		height?: number;
	}>(),
	{
		size: 'full',
	}
);

const chartHeight = computed(() => props.height ?? (props.size === 'full' ? 160 : 28));

// scaled so the tallest bar (rx or tx, whichever is larger) reaches 48 of the 50 units
// available above/below the center baseline, leaving a small margin
const maxValue = computed(() => Math.max(1, ...props.buckets.flatMap((b) => [b.rxBytes, b.txBytes])));

const rxHeight = (bucket: TrafficBucket) => (bucket.rxBytes / maxValue.value) * 48;
const txHeight = (bucket: TrafficBucket) => (bucket.txBytes / maxValue.value) * 48;

const formatTime = (value: string | number | Date) => new Date(value).toLocaleString();
</script>
