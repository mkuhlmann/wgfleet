<template>
	<div class="ts-chart-terminal flex flex-col gap-1.5">
		<div v-if="buckets.length === 0" class="flex items-center justify-center text-muted text-xs border border-border rounded-sm" :style="{ height: `${height}px` }">
			no data yet
		</div>
		<template v-else>
			<Chart :definition="definition" :height="height" :aria-label="ariaLabel" style="width: 100%" />
			<div class="flex justify-between text-[0.65rem] text-muted">
				<span>{{ formatTime(buckets[0].bucketStart) }}</span>
				<span>{{ formatTime(buckets[buckets.length - 1].bucketStart) }}</span>
			</div>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Chart } from '@tanstack/charts/vue';
import { defineChart, lineY, ruleY } from '@tanstack/charts';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { tooltip } from '@tanstack/charts/tooltip';
import { formatBytes } from '@app/lib/format';
import type { TrafficBucket } from '@app/lib/traffic';

const props = withDefaults(
	defineProps<{
		buckets: TrafficBucket[];
		height?: number;
		ariaLabel?: string;
	}>(),
	{
		height: 160,
		ariaLabel: 'Bandwidth over time',
	}
);

const formatTime = (value: string | number | Date) => new Date(value).toLocaleString();

// rx is plotted above the zero rule, tx mirrored below it (negated) - one lineY mark with a
// z-grouped series field so both paths share the same auto-fit linear y domain and the built-in
// grouped tooltip can show both values for the same bucket together.
type Row = { t: number; value: number; series: 'rx' | 'tx' };

const rows = computed<Row[]>(() =>
	props.buckets.flatMap((b) => {
		const t = new Date(b.bucketStart).getTime();
		return [
			{ t, value: b.rxBytes, series: 'rx' as const },
			{ t, value: -b.txBytes, series: 'tx' as const },
		];
	})
);

const definition = computed(() =>
	defineChart({
		marks: [
			ruleY([0], { stroke: 'var(--color-border)', strokeOpacity: 0.8 }),
			lineY(rows.value, {
				x: 't',
				y: 'value',
				z: 'series',
				strokeWidth: 2,
				stroke: (d) => (d.series === 'rx' ? 'var(--color-accent)' : 'var(--color-muted)'),
			}),
		],
		guides: false,
		scales: {
			x: { scale: scaleLinear },
			y: { scale: scaleLinear, nice: true },
		},
		focus: 'group-x',
		tooltip: {
			use: tooltip,
			formatGroup(points) {
				const heading = points[0] ? new Date(points[0].xValue as number).toLocaleString() : '';
				const lines = points.map((p) => {
					const datum = p.datum as Row;
					return `${datum.series}: ${formatBytes(Math.abs(datum.value))}`;
				});
				return [heading, ...lines].join('\n');
			},
		},
	})
);
</script>

<style scoped>
.ts-chart-terminal {
	--ts-chart-tooltip-background: var(--color-surface2);
	--ts-chart-tooltip-color: var(--color-text);
	--ts-chart-tooltip-border: 1px solid var(--color-border);
	--ts-chart-tooltip-border-radius: 2px;
	--ts-chart-tooltip-shadow: none;
	--ts-chart-tooltip-font: inherit;
	color: var(--color-muted);
}
</style>
