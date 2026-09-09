<template>
	<div class="flex flex-col gap-8">
		<div class="text-xs text-muted" v-if="isLoading">loading server... <span class="caret"></span></div>

		<div class="flex flex-col gap-4" v-if="server">
			<div class="flex items-center justify-between flex-wrap gap-3">
				<h1 class="text-lg font-bold text-text">
					<span class="text-accent-dim">///</span> {{ server.friendlyName ?? server.id }} <span class="text-muted">/ policy</span>
				</h1>
				<BaseButton :as="'router-link'" :to="{ name: 'servers-detail', params: { id: server.id } }" variant="ghost">&laquo; back to server</BaseButton>
			</div>

			<TagModal v-model:visible="showAddTagModal" :server="server" />
			<TagModal v-model:visible="showEditTagModal" :tag="selectedTag" :server="server" />

			<div class="flex flex-col gap-4">
				<div class="flex justify-between items-center flex-wrap gap-3">
					<h2 class="text-base font-bold text-text"><span class="text-accent-dim">///</span> tags</h2>
					<BaseButton @click="showAddTagModal = true">add tag</BaseButton>
				</div>

				<div v-if="!tags || tags.length === 0" class="text-center py-8 text-muted text-sm">no tags yet - untagged peers stay fully unrestricted</div>

				<div v-else class="grid gap-4 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
					<BaseCard v-for="tag in tags" :key="tag.id" :title="tag.friendlyName ?? tag.name" class="h-full flex flex-col">
						<div class="flex-1 flex flex-col gap-3">
							<div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm text-muted">
								<span class="whitespace-nowrap">name</span>
								<span class="text-text text-right break-all">{{ tag.name }}</span>

								<span class="whitespace-nowrap">peers</span>
								<span class="text-text text-right">{{ tag.memberCount }}</span>
							</div>
						</div>

						<template #footer>
							<div class="grid grid-cols-2 gap-2">
								<BaseButton @click="editTag(tag)" variant="secondary" size="sm">edit</BaseButton>
								<BaseButton @click="deleteTag(tag.id)" variant="danger" size="sm">del</BaseButton>
							</div>
						</template>
					</BaseCard>
				</div>
			</div>

			<div class="rule-line"></div>

			<div class="flex flex-col gap-4">
				<h2 class="text-base font-bold text-text"><span class="text-accent-dim">///</span> grants</h2>
				<p class="text-xs text-muted">
					evaluated top to bottom, first match wins. a tagged peer with no matching grant is denied by default - untagged peers stay unrestricted. place a
					<span class="text-text">peer</span>-scoped grant above a tag-scoped one to override it for that client.
				</p>
				<GrantsTable :server-id="server.id" :tags="tags ?? []" :peers="peers ?? []" />
			</div>

			<div class="rule-line"></div>

			<div class="flex flex-col gap-4">
				<h2 class="text-base font-bold text-text"><span class="text-accent-dim">///</span> policy json</h2>
				<PolicyJsonPanel :server-id="server.id" />
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { queryServer, queryServerPeers } from '@app/queries/queryServers';
import { queryServerTags } from '@app/queries/queryPolicy';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRoute } from 'vue-router';
import { ref } from 'vue';
import { eden } from '@app/queries/edenClient';
import { invalidate } from '@app/queries/keys';
import type { PeerTag } from '@server/db/schema';
import BaseButton from '@app/components/BaseButton.vue';
import BaseCard from '@app/components/BaseCard.vue';
import TagModal from '@app/components/TagModal.vue';
import GrantsTable from '@app/components/GrantsTable.vue';
import PolicyJsonPanel from '@app/components/PolicyJsonPanel.vue';

const route = useRoute();
const queryClient = useQueryClient();

const { data: server, isLoading } = useQuery(queryServer(route.params.id as string));
const { data: tags } = useQuery(queryServerTags(route.params.id as string));
const { data: peers } = useQuery(queryServerPeers(route.params.id as string));

const showAddTagModal = ref(false);
const showEditTagModal = ref(false);
const selectedTag = ref<PeerTag>();

const editTag = (tag: PeerTag) => {
	selectedTag.value = tag;
	showEditTagModal.value = true;
};

const deleteTag = async (tagId: string) => {
	if (!confirm('Delete this tag? Member peers keep their other tags, they are not deleted.')) return;

	await eden.api.v1.wg
		.servers({ id: route.params.id as string })
		.tags({ tagId })
		.delete();
	// a tag delete also unassigns member peers and removes referencing grants server-side
	// (policy.ts) - see invalidate.afterTagDelete
	await invalidate.afterTagDelete(queryClient, route.params.id as string);
};
</script>
