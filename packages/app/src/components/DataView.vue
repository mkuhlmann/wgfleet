<template>
	<div class="flex flex-col gap-5">
		<!-- Header / Controls -->
		<div class="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center">
			<div class="relative w-full sm:w-72">
				<BaseInput v-model="searchQuery" placeholder="search..." clearable>
					<template #icon-left><span>&gt;</span></template>
				</BaseInput>
			</div>

			<div class="flex items-center gap-1 bg-surface border border-border rounded-sm p-1">
				<button
					@click="currentLayout = 'grid'"
					:class="['px-3 py-1.5 rounded-sm text-xs font-semibold tracking-wide transition-colors', currentLayout === 'grid' ? 'bg-surface2 text-accent' : 'text-muted hover:text-text']"
				>
					[grid]
				</button>
				<button
					@click="currentLayout = 'table'"
					:class="['px-3 py-1.5 rounded-sm text-xs font-semibold tracking-wide transition-colors', currentLayout === 'table' ? 'bg-surface2 text-accent' : 'text-muted hover:text-text']"
				>
					[table]
				</button>
			</div>
		</div>

		<!-- Content -->
		<div v-if="filteredItems.length === 0" class="text-center py-12 text-muted text-sm">
			<slot name="empty">
				<p>no items found</p>
			</slot>
		</div>

		<div v-else>
			<!-- Grid Layout -->
			<div
				v-if="currentLayout === 'grid'"
				class="grid gap-4"
				:style="{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridMinColWidth}), 1fr))` }"
			>
				<div v-for="item in filteredItems" :key="item.id">
					<slot name="grid-item" :item="item" />
				</div>
			</div>

			<!-- Table Layout -->
			<div v-else class="overflow-x-auto rounded-sm border border-border">
				<table class="w-full text-left text-sm">
					<thead class="bg-surface text-xs uppercase tracking-wide text-muted">
						<tr>
							<slot name="table-header" />
						</tr>
					</thead>
					<tbody class="divide-y divide-border bg-surface/40">
						<tr v-for="item in filteredItems" :key="item.id" class="hover:bg-surface2 transition-colors">
							<slot name="table-row" :item="item" />
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts" generic="T extends { id: string | number }">
import { ref, computed } from 'vue';
import BaseInput from './BaseInput.vue';

const props = withDefaults(
	defineProps<{
		items: T[];
		filterFields?: (keyof T)[];
		defaultLayout?: 'grid' | 'table';
		gridMinColWidth?: string;
	}>(),
	{
		items: () => [],
		filterFields: () => [],
		defaultLayout: 'grid',
		gridMinColWidth: '440px',
	}
);

const currentLayout = ref(props.defaultLayout);
const searchQuery = ref('');

const filteredItems = computed(() => {
	if (!searchQuery.value) return props.items;

	const query = searchQuery.value.toLowerCase();
	return props.items.filter((item) => {
		return props.filterFields.some((field) => {
			const value = item[field];
			return String(value).toLowerCase().includes(query);
		});
	});
});
</script>
