<template>
	<div class="flex flex-col gap-8">
		<div class="text-xs text-muted" v-if="isLoading">loading servers... <span class="caret"></span></div>

		<div class="flex justify-between items-center flex-wrap gap-3">
			<h1 class="text-lg font-bold text-text"><span class="text-accent-dim">///</span> servers</h1>
			<BaseButton @click="showAddModal = true">add server</BaseButton>
		</div>

		<DataView :items="servers || []" :filter-fields="['id', 'friendlyName', 'wgEndpoint']" default-layout="grid">
			<template #grid-item="{ item: server }">
				<BaseCard :title="server.friendlyName ?? server.id" class="h-full flex flex-col">
					<div class="flex-1">
						<div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm text-muted">
							<span class="whitespace-nowrap">id</span>
							<span class="text-text text-right break-all">{{ server.id }}</span>

							<span class="whitespace-nowrap">endpoint</span>
							<span class="text-text text-right break-all">{{ server.wgEndpoint }}</span>
						</div>
					</div>

					<template #footer>
						<div class="flex gap-2">
							<BaseButton as="router-link" :to="'/servers/' + server.id" variant="secondary" class="flex-1"> view </BaseButton>
							<BaseButton @click="editServer(server)" variant="ghost"> edit </BaseButton>
						</div>
					</template>
				</BaseCard>
			</template>

			<template #table-header>
				<th class="px-4 py-2.5">name/id</th>
				<th class="px-4 py-2.5">endpoint</th>
				<th class="px-4 py-2.5 text-right">actions</th>
			</template>

			<template #table-row="{ item: server }">
				<td class="px-4 py-3 font-medium text-text">
					{{ server.friendlyName ?? server.id }}
				</td>
				<td class="px-4 py-3 text-muted">
					{{ server.wgEndpoint }}
				</td>
				<td class="px-4 py-3 text-right">
					<div class="flex justify-end gap-2">
						<BaseButton as="router-link" :to="'/servers/' + server.id" variant="secondary" size="sm"> view </BaseButton>
						<BaseButton @click="editServer(server)" variant="ghost" size="sm"> edit </BaseButton>
					</div>
				</td>
			</template>
		</DataView>
	</div>

	<ServerModal v-model:visible="showAddModal" :servers="servers ?? []" />
	<ServerModal v-model:visible="showEditModal" :server="selectedServer" :servers="servers ?? []" />
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { queryServers } from '@app/queries/queryServers';
import { useQuery } from '@tanstack/vue-query';
import ServerModal from '@app/components/ServerModal.vue';
import type { ServerPeer } from '@server/db/schema';
import BaseButton from '@app/components/BaseButton.vue';
import BaseCard from '@app/components/BaseCard.vue';
import DataView from '@app/components/DataView.vue';

const { data: servers, isLoading } = useQuery(queryServers());
const showAddModal = ref(false);
const showEditModal = ref(false);
const selectedServer = ref<ServerPeer>();

const editServer = (server: ServerPeer) => {
	selectedServer.value = server;
	showEditModal.value = true;
};
</script>
