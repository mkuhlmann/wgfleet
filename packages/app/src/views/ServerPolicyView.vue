<template>
	<div class="flex flex-col gap-8">
		<div class="text-xs text-muted" v-if="isLoading">loading server... <span class="caret"></span></div>

		<div class="flex flex-col gap-4" v-if="server">
			<div class="flex items-center justify-between flex-wrap gap-3">
				<h1 class="text-lg font-bold text-text"><span class="text-accent-dim">///</span> {{ server.friendlyName ?? server.id }} <span class="text-muted">/ policy</span></h1>
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
				<h2 class="text-base font-bold text-text"><span class="text-accent-dim">///</span> exit nodes</h2>
				<p class="text-xs text-muted">
					an exit node routes another client's internet traffic through its own uplink. this is not a grant - it lives on the peer, because it decides
					<span class="text-text">routing</span>, not permission. a client with no exit node has no route to one at all, so it cannot use one by editing its own config. only one exit node per interface.
				</p>

				<div v-if="exitNodes.length === 0" class="text-center py-8 text-muted text-sm">no exit node on this server - mark a peer as one from the peers list</div>

				<div v-else class="grid gap-4 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
					<BaseCard v-for="node in exitNodes" :key="node.id" :title="node.friendlyName ?? node.wgAddress" class="h-full flex flex-col">
						<div class="flex flex-col gap-3">
							<div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm text-muted">
								<span class="whitespace-nowrap">address</span>
								<span class="text-text text-right break-all">{{ node.wgAddress }}</span>

								<span class="whitespace-nowrap">exit dns</span>
								<span class="text-text text-right break-all">{{ node.exitDns ?? server.dns ?? '-' }}</span>

								<span class="whitespace-nowrap">route table</span>
								<span class="text-text text-right">{{ server.routeTableId }}</span>
							</div>

							<div>
								<div class="text-sm text-muted mb-1.5">clients</div>
								<div v-if="clientsOf(node.id).length === 0" class="text-xs text-muted">none assigned yet</div>
								<div v-else class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
									<span v-for="client in clientsOf(node.id)" :key="client.id" class="text-accent-dim">
										{{ client.friendlyName ?? client.wgAddress }}
									</span>
								</div>
							</div>
						</div>
					</BaseCard>
				</div>
			</div>

			<div class="rule-line"></div>

			<div class="flex flex-col gap-4">
				<h2 class="text-base font-bold text-text"><span class="text-accent-dim">///</span> subnet routes</h2>
				<p class="text-xs text-muted">
					a peer can advertise networks behind it, so clients reach that lan through the tunnel. this half <span class="text-text">is</span> a grant question: the route only decides which peer owns the prefix, and reaching it still needs an
					<span class="text-text">allow &rarr; cidr</span> grant above. one owner per prefix, across every interface on this host - overlapping advertisements are rejected.
				</p>

				<div v-if="advertisers.length === 0" class="text-center py-8 text-muted text-sm">no advertised subnet routes on this server - add one from a peer's edit dialog</div>

				<div v-else class="grid gap-4 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
					<BaseCard v-for="peer in advertisers" :key="peer.id" :title="peer.friendlyName ?? peer.wgAddress" class="h-full flex flex-col">
						<div class="flex flex-col gap-3">
							<div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm text-muted">
								<span class="whitespace-nowrap">address</span>
								<span class="text-text text-right break-all">{{ peer.wgAddress }}</span>

								<span class="whitespace-nowrap">also exit node</span>
								<span class="text-text text-right">{{ peer.isExitNode ? 'yes' : 'no' }}</span>
							</div>

							<div>
								<div class="text-sm text-muted mb-1.5">advertises</div>
								<div class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
									<span v-for="cidr in routesOf(peer)" :key="cidr" class="text-accent-dim">{{ cidr }}</span>
								</div>
							</div>

							<div v-if="ungrantedRoutes(peer).length" class="text-xs text-muted">no <span class="text-text">allow &rarr; cidr</span> grant references {{ ungrantedRoutes(peer).join(', ') }} yet, so no client can reach it</div>
						</div>
					</BaseCard>
				</div>
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
import { queryServerGrants, queryServerTags } from '@app/queries/queryPolicy';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRoute } from 'vue-router';
import { ref, computed } from 'vue';
import { eden } from '@app/queries/edenClient';
import { invalidate } from '@app/queries/keys';
import type { PeerTag } from '@server/db/schema';
import { advertisedRoutesOf } from '@server/lib/exitTopology';
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
// same query key GrantsTable below uses, so this is the cached read, not a second request
const { data: grants } = useQuery(queryServerGrants(route.params.id as string));

// Exit assignment isn't a grant (it's peers.exitPeerId, see wg/exitRouting.ts), so
// it gets its own panel rather than a row in GrantsTable.
const exitNodes = computed(() => (peers.value ?? []).filter((p) => p.isExitNode));
const clientsOf = (exitPeerId: string) => (peers.value ?? []).filter((p) => p.exitPeerId === exitPeerId);

// Advertised subnet routes are the other half of the same story:
// also a column on the peer, but destination-routed and permissioned by ordinary cidr grants
// rather than by an assignment - hence its own section instead of a column here.
const routesOf = advertisedRoutesOf;
const advertisers = computed(() => (peers.value ?? []).filter((p) => routesOf(p).length > 0));

// A peer can advertise a prefix nothing grants access to, which looks configured and reaches
// nobody - the one failure mode of this feature that isn't an error, so it's surfaced here.
const ungrantedRoutes = (peer: { advertisedRoutes: string | null }) => {
	const granted = new Set((grants.value ?? []).filter((g) => g.enabled && g.action === 'allow' && g.dstKind === 'cidr' && g.dstCidr).map((g) => g.dstCidr!));
	return routesOf(peer).filter((cidr) => !granted.has(cidr));
};

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
