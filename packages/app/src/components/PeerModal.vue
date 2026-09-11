<template>
	<BaseModal v-model:visible="visible" :header="isEditMode ? 'edit peer' : 'add peer'">
		<form @submit.prevent="handleSubmit" class="flex flex-col gap-5">
			<div class="field">
				<label for="friendlyName" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> friendly name</label>
				<BaseInput id="friendlyName" v-model="form.friendlyName" class="w-full" placeholder="e.g. sales-ipad-07" />
				<small class="text-muted text-xs">a memorable name for this client device</small>
			</div>
			<div class="field">
				<label for="wgAddress" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> wireguard address</label>
				<BaseInput id="wgAddress" v-model="form.wgAddress" class="w-full" placeholder="leave empty to auto-assign" />
				<small class="text-muted text-xs">static ip address (optional). next free address is used if left blank</small>
				<span v-if="errors.wgAddress" class="text-down text-xs block mt-1">{{ errors.wgAddress }}</span>
			</div>
			<div class="field">
				<label class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> tags</label>
				<div v-if="!tags || tags.length === 0" class="text-xs text-muted">no tags defined yet - add one from the server's policy page first</div>
				<div v-else class="flex flex-wrap gap-x-4 gap-y-2">
					<button v-for="tag in tags" :key="tag.id" type="button" class="flex items-center gap-2 text-sm text-text" @click="toggleTag(tag.id)">
						<span class="text-accent-dim">{{ form.tagIds.includes(tag.id) ? '[x]' : '[ ]' }}</span>
						<span>{{ tag.friendlyName ?? tag.name }}</span>
					</button>
				</div>
				<small class="text-muted text-xs">restricts reachability to what the policy's grants allow. leave all unset for unrestricted access</small>
			</div>

			<div class="rule-line"></div>

			<div class="field">
				<button type="button" class="flex items-center gap-2 text-sm text-text" @click="toggleExitNode">
					<span class="text-accent-dim">{{ form.isExitNode ? '[x]' : '[ ]' }}</span>
					<span><span class="text-accent-dim">&gt;</span> exit node</span>
				</button>
				<small class="text-muted text-xs block mt-1">route other clients' internet traffic through this peer's own uplink. only one peer per interface can be an exit node, and it stays an ordinary reachable peer</small>
				<span v-if="errors.isExitNode" class="text-down text-xs block mt-1">{{ errors.isExitNode }}</span>
			</div>

			<div class="field" v-if="form.isExitNode">
				<label for="exitDns" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> exit dns</label>
				<BaseInput id="exitDns" v-model="form.exitDns" class="w-full" placeholder="leave empty to use the server's dns" />
				<small class="text-muted text-xs">resolver handed to clients using this exit node. without one, their lookups go to whatever their local network provides</small>
			</div>

			<div class="field" v-else>
				<label class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> internet access</label>
				<div class="flex flex-col gap-2">
					<button type="button" class="flex items-center gap-2 text-sm text-text text-left" @click="form.exitPeerId = null">
						<span class="text-accent-dim">{{ form.exitPeerId === null ? '(x)' : '( )' }}</span>
						<span>none / via hub</span>
					</button>
					<button v-for="node in exitNodes" :key="node.id" type="button" class="flex items-center gap-2 text-sm text-text text-left" @click="form.exitPeerId = node.id">
						<span class="text-accent-dim">{{ form.exitPeerId === node.id ? '(x)' : '( )' }}</span>
						<span>via exit node {{ node.friendlyName ?? node.wgAddress }}</span>
					</button>
				</div>
				<small class="text-muted text-xs block mt-1">
					<span v-if="exitNodes.length === 0">no exit node on this server yet - mark a peer as one first</span>
					<span v-else>picking an exit node gives this peer a second config file to switch to. without one it has no route to any exit node at all</span>
				</small>
			</div>

			<div class="rule-line"></div>

			<div class="field">
				<label for="advertisedRoutes" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> advertised subnet routes</label>
				<BaseInput id="advertisedRoutes" v-model="form.advertisedRoutes" class="w-full" placeholder="e.g. 192.168.1.0/24, 10.10.0.0/16" />
				<small class="text-muted text-xs">
					networks behind this peer, reachable through it. unlike an exit node this grants nothing on its own - clients reach an advertised network only through an
					<span class="text-text">allow &rarr; cidr</span> grant. one owner per prefix, across every interface on this host
				</small>
				<span v-if="errors.advertisedRoutes" class="text-down text-xs block mt-1">{{ errors.advertisedRoutes }}</span>
			</div>

			<div class="flex justify-end gap-2 mt-2">
				<BaseButton @click="visible = false" variant="ghost" type="button">cancel</BaseButton>
				<BaseButton type="submit" variant="primary">
					{{ isEditMode ? 'save changes' : 'add peer' }}
				</BaseButton>
			</div>
		</form>
	</BaseModal>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue';
import { useToast } from '@app/composables/useToast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { Peer, ServerPeer } from '@server/db/schema';
import { CIDR_REGEX, IPV4_ADDRESS_REGEX, parseCidrList } from '@server/lib/validation';
import { checkPeerInvariants } from '@server/lib/peerInvariants';
import { eden } from '@app/queries/edenClient';
import { queryServerGrants, queryServerTags } from '@app/queries/queryPolicy';
import { queryServerPeers } from '@app/queries/queryServers';
import { invalidate } from '@app/queries/keys';
import BaseButton from './BaseButton.vue';
import BaseInput from './BaseInput.vue';
import BaseModal from './BaseModal.vue';

const toast = useToast();

const props = defineProps<{
	// wgLast* are internal delta-tracking bookkeeping the api never returns (see serversPeers.ts)
	peer?: Omit<Peer, 'wgLastRxBytes' | 'wgLastTxBytes' | 'wgLastSampledAt'> & { tagIds?: string[] };
	server: ServerPeer;
}>();

const isEditMode = ref(props.peer ? true : false);

const visible = defineModel<boolean>('visible', { required: true });
const queryClient = useQueryClient();

const { data: tags } = useQuery(queryServerTags(props.server.id));
const { data: peers } = useQuery(queryServerPeers(props.server.id));
// Only needed for the "already has an allow -> internet grant" invariant below - the one rule
// in lib/peerInvariants.ts that reads something other than this server's peers.
const { data: grants } = useQuery(queryServerGrants(props.server.id));

const form = reactive<{
	friendlyName?: string;
	wgAddress?: string;
	tagIds: string[];
	isExitNode: boolean;
	exitPeerId: string | null;
	exitDns: string;
	advertisedRoutes: string;
}>({
	friendlyName: '',
	wgAddress: '',
	tagIds: [],
	isExitNode: false,
	exitPeerId: null,
	exitDns: '',
	advertisedRoutes: '',
});

// Every *other* peer on this server that is marked as an exit node - the server allows only
// one, so this is 0 or 1 entries in practice, but rendering the list keeps the ui honest if a
// direct db write ever produced more.
const exitNodes = computed(() => (peers.value ?? []).filter((p) => p.isExitNode && p.id !== props.peer?.id));

// Being an exit node and using one are mutually exclusive (the api rejects both) - it would
// be a routing loop, and the two roles need different AllowedIPs.
const toggleExitNode = () => {
	form.isExitNode = !form.isExitNode;
	if (form.isExitNode) form.exitPeerId = null;
	else form.exitDns = '';
};

const toggleTag = (tagId: string) => {
	form.tagIds = form.tagIds.includes(tagId) ? form.tagIds.filter((id) => id !== tagId) : [...form.tagIds, tagId];
};

const errors = reactive({
	wgAddress: '',
	isExitNode: '',
	advertisedRoutes: '',
});

// The per-server state lib/peerInvariants.ts decides against, assembled from what this form
// already has in cache.
const invariantSnapshot = computed(() => ({
	peers: peers.value ?? [],
	tagIds: (tags.value ?? []).map((t) => t.id),
	internetGrantPeerIds: (grants.value ?? []).filter((g) => g.enabled && g.action === 'allow' && g.srcKind === 'peer' && g.dstKind === 'internet' && g.srcPeerId).map((g) => g.srcPeerId!),
}));

const validate = () => {
	let isValid = true;
	errors.wgAddress = '';
	errors.isExitNode = '';
	errors.advertisedRoutes = '';

	if (form.wgAddress) {
		if (!IPV4_ADDRESS_REGEX.test(form.wgAddress)) {
			errors.wgAddress = 'Invalid IP address format. WireGuard peer addresses are IPv4 only.';
			isValid = false;
		}
	}

	// The same function the api decides with (lib/peerInvariants.ts) - all six exit-node rules,
	// not the two this form used to re-implement by hand. The other four used to reach the user
	// only as a toast after a failed round trip.
	const invariantError = checkPeerInvariants(invariantSnapshot.value, props.peer ?? null, {
		tagIds: form.tagIds,
		isExitNode: form.isExitNode,
		exitPeerId: form.exitPeerId,
	});
	if (invariantError) {
		errors.isExitNode = invariantError;
		isValid = false;
	}

	// Format only. Whether a prefix overlaps another peer's advertisement or the server's own
	// range depends on every other peer, so that check stays server-side
	// (resolveAdvertisedRoutesFor in api/serversPeers.ts) and surfaces as a toast.
	for (const entry of parseCidrList(form.advertisedRoutes)) {
		if (!CIDR_REGEX.test(entry)) {
			errors.advertisedRoutes = `Invalid CIDR: ${entry}. Subnet routes are IPv4 only, e.g. 192.168.1.0/24.`;
			isValid = false;
		} else if (entry.endsWith('/0')) {
			errors.advertisedRoutes = 'A default route is what an exit node advertises - use the exit node checkbox instead of 0.0.0.0/0.';
			isValid = false;
		}
	}

	return isValid;
};

watch(
	() => props.peer,
	(peer) => {
		if (peer) {
			form.friendlyName = peer.friendlyName ?? '';
			form.wgAddress = peer.wgAddress ?? '';
			form.tagIds = peer.tagIds ?? [];
			form.isExitNode = peer.isExitNode ?? false;
			form.exitPeerId = peer.exitPeerId ?? null;
			form.exitDns = peer.exitDns ?? '';
			form.advertisedRoutes = peer.advertisedRoutes ?? '';
			isEditMode.value = true;
		} else {
			isEditMode.value = false;
			form.friendlyName = '';
			form.wgAddress = '';
			form.tagIds = [];
			form.isExitNode = false;
			form.exitPeerId = null;
			form.exitDns = '';
			form.advertisedRoutes = '';
		}
		errors.wgAddress = '';
		errors.isExitNode = '';
		errors.advertisedRoutes = '';
	},
	{ immediate: true }
);

// exitDns and advertisedRoutes are clearable: '' from the input becomes null (clear), which
// `typeof form`'s `string` doesn't allow.
type PeerPayload = Omit<typeof form, 'exitDns' | 'advertisedRoutes'> & { exitDns: string | null; advertisedRoutes: string | null };

const createPeer = useMutation({
	mutationFn: async (data: PeerPayload) => {
		const res = await eden.api.v1.wg.servers({ id: props.server.id }).peers.post(data);
		return res.data;
	},
	onSuccess: async () => {
		await invalidate.afterPeerChange(queryClient, props.server.id);
		visible.value = false;
	},
	onError: (error) => {
		toast.add({
			severity: 'error',
			detail: error.message,
			summary: 'Failed to create peer',
			life: 5000,
		});
	},
});

const updatePeer = useMutation({
	mutationFn: async (data: PeerPayload) => {
		if (!props.peer) return;
		const res = await eden.api.v1.wg.servers({ id: props.server.id }).peers({ peerId: props.peer.id }).patch(data);
		return res.data;
	},
	onSuccess: async () => {
		await invalidate.afterPeerChange(queryClient, props.server.id);
		visible.value = false;
	},
	onError: (error) => {
		toast.add({
			severity: 'error',
			detail: error.message,
			summary: 'Failed to update peer',
			life: 5000,
		});
	},
});

const handleSubmit = () => {
	if (!validate()) {
		return;
	}
	const data = { ...form, exitDns: form.exitDns || null, advertisedRoutes: form.advertisedRoutes || null };
	if (data.wgAddress === '') {
		data.wgAddress = undefined;
	}
	if (data.friendlyName === '') {
		data.friendlyName = undefined;
	}
	if (isEditMode.value) {
		updatePeer.mutate(data);
	} else {
		createPeer.mutate(data);
	}
};
</script>
