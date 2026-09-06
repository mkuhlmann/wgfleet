<template>
	<div v-if="!grants || grants.length === 0" class="text-center py-8 text-muted text-sm">no grants yet - tagged peers are denied by default until you add one</div>

	<div v-else class="overflow-x-auto rounded-sm border border-border">
		<table class="text-left text-sm border-collapse w-full">
			<thead class="bg-surface text-xs uppercase tracking-wide text-muted">
				<tr>
					<th class="px-3 py-2.5 text-right">#</th>
					<th class="px-3 py-2.5">on</th>
					<th class="px-3 py-2.5">action</th>
					<th class="px-3 py-2.5">source</th>
					<th class="px-3 py-2.5">destination</th>
					<th class="px-3 py-2.5">proto/ports</th>
					<th class="px-3 py-2.5">comment</th>
					<th class="px-3 py-2.5 text-right">actions</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-border bg-surface/40">
				<tr v-for="(grant, index) in grants" :key="grant.id" class="hover:bg-surface2 transition-colors" :class="{ 'opacity-40': !grant.enabled }">
					<td class="px-3 py-2.5 text-muted text-right">{{ index + 1 }}</td>
					<td class="px-3 py-2.5">
						<button type="button" class="text-accent-dim hover:text-accent transition-colors disabled:opacity-40" :disabled="isMutating" @click="toggleEnabled(grant)">
							{{ grant.enabled ? '[x]' : '[ ]' }}
						</button>
					</td>
					<td class="px-3 py-2.5 font-medium whitespace-nowrap" :class="grant.action === 'allow' ? 'text-up' : 'text-down'">{{ grant.action }}</td>
					<td class="px-3 py-2.5 text-text whitespace-nowrap">{{ describeEndpoint(grant.srcKind, grant.srcTagId, grant.srcPeerId) }}</td>
					<td class="px-3 py-2.5 text-text whitespace-nowrap">{{ describeEndpoint(grant.dstKind, grant.dstTagId, grant.dstPeerId, grant.dstCidr) }}</td>
					<td class="px-3 py-2.5 text-muted whitespace-nowrap">{{ describeL4(grant.protocol, grant.ports) }}</td>
					<td class="px-3 py-2.5 text-muted">{{ grant.comment || '-' }}</td>
					<td class="px-3 py-2.5">
						<div class="flex justify-end items-center gap-1.5 flex-nowrap">
							<button
								type="button"
								class="text-accent-dim hover:text-accent transition-colors disabled:opacity-20"
								:disabled="index === 0 || isMutating"
								title="move up"
								@click="move(index, -1)"
							>
								[ ^ ]
							</button>
							<button
								type="button"
								class="text-accent-dim hover:text-accent transition-colors disabled:opacity-20"
								:disabled="index === grants.length - 1 || isMutating"
								title="move down"
								@click="move(index, 1)"
							>
								[ v ]
							</button>
							<BaseButton @click="edit(grant, index)" variant="secondary" size="sm">edit</BaseButton>
							<BaseButton @click="remove(index)" variant="danger" size="sm">del</BaseButton>
						</div>
					</td>
				</tr>
			</tbody>
		</table>
	</div>

	<div class="mt-4">
		<BaseButton @click="add">add grant</BaseButton>
	</div>

	<GrantModal v-model:visible="showModal" :tags="tags" :peers="peers" :grant="editingGrant" @save="handleSave" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { queryServerGrants } from '@app/queries/queryPolicy';
import { eden } from '@app/queries/edenClient';
import { useToast } from '@app/composables/useToast';
import type { PeerTag, Peer, PolicyGrant } from '@server/db/schema';
import BaseButton from './BaseButton.vue';
import GrantModal, { type GrantDraft } from './GrantModal.vue';

const props = defineProps<{
	serverId: string;
	tags: PeerTag[];
	peers: Pick<Peer, 'id' | 'friendlyName'>[];
}>();

const toast = useToast();
const queryClient = useQueryClient();

const { data: grants } = useQuery(queryServerGrants(props.serverId));

const tagName = (id?: string | null) => {
	if (!id) return '?';
	const tag = props.tags.find((t) => t.id === id);
	return tag ? (tag.friendlyName ?? tag.name) : '(deleted tag)';
};

const peerName = (id?: string | null) => {
	if (!id) return '?';
	const peer = props.peers.find((p) => p.id === id);
	return peer ? (peer.friendlyName ?? id) : '(deleted peer)';
};

const describeEndpoint = (kind: string, tagId?: string | null, peerId?: string | null, cidr?: string | null) => {
	switch (kind) {
		case 'tag':
			return `tag:${tagName(tagId)}`;
		case 'peer':
			return `peer:${peerName(peerId)}`;
		case 'cidr':
			return cidr ?? '?';
		default:
			return kind;
	}
};

const describeL4 = (protocol: string, ports: string | null) => {
	if (protocol === 'any') return 'any';
	if (ports && ports.trim()) return `${protocol}:${ports}`;
	return protocol;
};

const invalidate = () => queryClient.invalidateQueries({ queryKey: ['serverGrants', props.serverId] });

const replaceAll = useMutation({
	mutationFn: async (body: GrantDraft[]) => {
		const res = await eden.api.v1.wg.servers({ id: props.serverId }).grants.put({ grants: body });
		return res.data;
	},
	onSuccess: invalidate,
	onError: (error: Error) => toast.add({ severity: 'error', detail: error.message, summary: 'Failed to update grants', life: 5000 }),
});

const isMutating = computed(() => replaceAll.isPending.value);

// every mutation here (toggle/move/delete/save) works by rebuilding the full ordered array
// from the current server state and PUTting it back - the api replaces the whole list per
// request (see api/policy.ts), array index becomes `position`.
const toDraft = (g: PolicyGrant): GrantDraft => ({
	enabled: g.enabled,
	action: g.action as GrantDraft['action'],
	srcKind: g.srcKind as GrantDraft['srcKind'],
	srcTagId: g.srcTagId ?? undefined,
	srcPeerId: g.srcPeerId ?? undefined,
	dstKind: g.dstKind as GrantDraft['dstKind'],
	dstTagId: g.dstTagId ?? undefined,
	dstPeerId: g.dstPeerId ?? undefined,
	dstCidr: g.dstCidr ?? undefined,
	protocol: g.protocol as GrantDraft['protocol'],
	ports: g.ports ?? undefined,
	comment: g.comment ?? undefined,
});

const currentDrafts = () => (grants.value ?? []).map(toDraft);

const toggleEnabled = (grant: PolicyGrant) => {
	const list = currentDrafts();
	const index = (grants.value ?? []).findIndex((g) => g.id === grant.id);
	if (index === -1) return;
	list[index] = { ...list[index], enabled: !list[index].enabled };
	replaceAll.mutate(list);
};

const move = (index: number, delta: number) => {
	const list = currentDrafts();
	const target = index + delta;
	if (target < 0 || target >= list.length) return;
	[list[index], list[target]] = [list[target], list[index]];
	replaceAll.mutate(list);
};

const remove = (index: number) => {
	if (!confirm('Delete this grant?')) return;
	const list = currentDrafts();
	list.splice(index, 1);
	replaceAll.mutate(list);
};

const showModal = ref(false);
const editingGrant = ref<PolicyGrant | undefined>(undefined);
const editingIndex = ref<number | null>(null);

const add = () => {
	editingGrant.value = undefined;
	editingIndex.value = null;
	showModal.value = true;
};

const edit = (grant: PolicyGrant, index: number) => {
	editingGrant.value = grant;
	editingIndex.value = index;
	showModal.value = true;
};

const handleSave = (draft: GrantDraft) => {
	const list = currentDrafts();
	if (editingIndex.value !== null) {
		list[editingIndex.value] = draft;
	} else {
		list.push(draft); // new grants land at the end - use [ ^ ] to prioritize
	}
	replaceAll.mutate(list);
};
</script>
