<template>
	<BaseModal v-model:visible="visible" :header="isEditMode ? 'edit peer' : 'add peer'" width="lg">
		<!--
			Two panes: what this peer *is* and what it exposes, against how it reaches the internet.
			They stack below md, so the same markup is one readable column on a phone. The form lives
			in the content slot while its actions sit in the modal footer, hence the `form` attribute
			on the submit button.
		-->
		<form :id="formId" @submit.prevent="handleSubmit" class="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
			<div class="flex flex-col gap-5">
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

				<div class="field">
					<label for="advertisedRoutes" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> advertised subnet routes</label>
					<BaseInput id="advertisedRoutes" v-model="form.advertisedRoutes" class="w-full" placeholder="e.g. 192.168.1.0/24, 10.10.0.0/16" />
					<small class="text-muted text-xs">
						networks behind this peer, reachable through it. unlike an exit node this grants nothing on its own - clients reach an advertised network only through an
						<span class="text-text">allow &rarr; cidr</span> grant. one owner per prefix, across every interface on this host
					</small>
					<span v-if="errors.advertisedRoutes" class="text-down text-xs block mt-1">{{ errors.advertisedRoutes }}</span>
				</div>
			</div>

			<div class="flex flex-col gap-5 md:border-l md:border-border md:pl-6">
				<!-- the pane divider is a vertical hairline on md+, so stacked it needs the horizontal one -->
				<div class="rule-line md:hidden"></div>

				<div class="field">
					<button type="button" class="flex items-center gap-2 text-sm text-text" @click="toggleExitNode">
						<span class="text-accent-dim">{{ form.isExitNode ? '[x]' : '[ ]' }}</span>
						<span><span class="text-accent-dim">&gt;</span> exit node</span>
					</button>
					<small class="text-muted text-xs block mt-1">
						route other clients' internet traffic through this peer's own uplink. it stays an ordinary reachable peer. a server can have
						<span class="text-text">as many exit nodes as you like</span> - each gets a wg interface of its own here, so they never compete for <span class="text-text">0.0.0.0/0</span>.
					</small>
					<span v-if="errors.isExitNode" class="text-down text-xs block mt-1">{{ errors.isExitNode }}</span>
				</div>

				<template v-if="form.isExitNode">
					<div class="field">
						<label for="exitListenPort" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> exit link udp port</label>
						<BaseInput id="exitListenPort" v-model="exitListenPortInput" type="number" class="w-full" :placeholder="currentLink ? String(currentLink.listenPort) : 'auto (51900-51999)'" />
						<small class="text-muted text-xs block mt-1"> this exit node connects to a <span class="text-text">separate wg interface</span> on this host, on its own port. leave empty to allocate one automatically. </small>
						<small class="text-down text-xs block mt-1">
							open this port <span class="text-text">here, on the wgfleet host</span> - publish it on the container (<span class="text-text">-p {{ currentLink?.listenPort ?? '&lt;port&gt;' }}:{{ currentLink?.listenPort ?? '&lt;port&gt;' }}/udp</span
							>) and allow it inbound. <span class="text-text">nothing is opened on the exit node's own machine</span>: it dials in, so it works from behind nat exactly like any other peer. nothing about your clients changes.
						</small>
						<div v-if="currentLink" class="text-xs text-muted mt-1">
							currently <span class="text-text">{{ currentLink.interfaceName }}</span> on udp <span class="text-text">{{ currentLink.listenPort }}</span>
						</div>
						<span v-if="errors.exitListenPort" class="text-down text-xs block mt-1">{{ errors.exitListenPort }}</span>
					</div>

					<div class="field">
						<label for="exitDns" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> exit dns</label>
						<BaseInput id="exitDns" v-model="form.exitDns" class="w-full" placeholder="leave empty to use the server's dns" />
						<small class="text-muted text-xs">resolver handed to clients using this exit node. without one, their lookups go to whatever their local network provides</small>
					</div>

					<div class="field">
						<small class="text-down text-xs block">
							this machine has to forward and masquerade for others, and ticking the box above does not change its config by itself - reinstall its own config from the peer list (<span class="text-text">cfg + nat</span>) and restart its tunnel, or
							this exit node's clients will simply time out. its endpoint port changes too.
						</small>
					</div>
				</template>

				<div class="field" v-else>
					<label class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> internet access</label>
					<div class="flex flex-col gap-2">
						<button type="button" class="flex items-center gap-2 text-sm text-text text-left" @click="selectExit(null, false)">
							<span class="text-accent-dim">{{ form.exitPeerId === null && !form.exitViaServer ? '(x)' : '( )' }}</span>
							<span>none</span>
						</button>
						<button v-if="props.server.isExitNode" type="button" class="flex items-center gap-2 text-sm text-text text-left" @click="selectExit(null, true)">
							<span class="text-accent-dim">{{ form.exitViaServer ? '(x)' : '( )' }}</span>
							<span>via this server ({{ props.server.interfaceName }}, udp {{ props.server.wgListenPort }})</span>
						</button>
						<button v-for="node in exitNodes" :key="node.peer.id" type="button" class="flex items-center gap-2 text-sm text-text text-left" @click="selectExit(node.peer.id, false)">
							<span class="text-accent-dim">{{ form.exitPeerId === node.peer.id ? '(x)' : '( )' }}</span>
							<span>via exit node {{ node.peer.friendlyName ?? node.peer.wgAddress }}</span>
							<span v-if="!node.link" class="text-down text-xs">(no interface yet)</span>
						</button>
					</div>
					<span v-if="errors.exitViaServer" class="text-down text-xs block mt-1">{{ errors.exitViaServer }}</span>
					<small class="text-muted text-xs block mt-1">
						<span v-if="exitNodes.length === 0 && !props.server.isExitNode">no exit available yet - enable the server's own exit in its settings, or mark a peer as an exit node</span>
						<span v-else>picking an exit node gives this peer a second config file to switch to. any exit node on this server will do, and switching later changes nothing else. without one it has no route to any exit node at all</span>
					</small>
				</div>
			</div>
		</form>

		<template #footer>
			<BaseButton @click="visible = false" variant="ghost" type="button">cancel</BaseButton>
			<BaseButton :form="formId" type="submit" variant="primary">
				{{ isEditMode ? 'save changes' : 'add peer' }}
			</BaseButton>
		</template>
	</BaseModal>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed, useId } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useWrite } from '@app/queries/useWrite';
import type { Peer, ServerPeer } from '@server/db/schema';
import { IPV4_ADDRESS_REGEX, WG_LISTEN_PORT_MAX, WG_LISTEN_PORT_MIN, normalizeCidr, parseCidrList } from '@server/lib/validation';
import { checkAdvertisedRoute, checkPeerInvariants } from '@server/lib/peerInvariants';
import { exitLinkOf, exitTopologyOf } from '@server/lib/exitTopology';
import { eden } from '@app/queries/edenClient';
import { queryServerTags } from '@app/queries/queryPolicy';
import { queryServerPeers } from '@app/queries/queryServers';
import { invalidate } from '@app/queries/keys';
import BaseButton from './BaseButton.vue';
import BaseInput from './BaseInput.vue';
import BaseModal from './BaseModal.vue';

const props = defineProps<{
	// wgLast* are internal delta-tracking bookkeeping the api never returns (see serversPeers.ts)
	peer?: Omit<Peer, 'wgLastRxBytes' | 'wgLastTxBytes' | 'wgLastSampledAt'> & { tagIds?: string[] };
	server: ServerPeer;
}>();

// The submit button lives in the modal footer, outside the <form> - `form=` associates them,
// and the id has to be unique in case two of these are mounted at once.
const formId = useId();

const isEditMode = ref(props.peer ? true : false);

const visible = defineModel<boolean>('visible', { required: true });

const { data: tags } = useQuery(queryServerTags(props.server.id));
const { data: peers } = useQuery(queryServerPeers(props.server.id));

const form = reactive<{
	friendlyName?: string;
	wgAddress?: string;
	tagIds: string[];
	isExitNode: boolean;
	exitPeerId: string | null;
	exitViaServer: boolean;
	exitDns: string;
	advertisedRoutes: string;
}>({
	friendlyName: '',
	wgAddress: '',
	tagIds: [],
	isExitNode: false,
	exitPeerId: null,
	exitViaServer: false,
	exitDns: '',
	advertisedRoutes: '',
});

// Every *other* exit node on this server - any number of them, and this peer may point at any
// one. Same projection the configs, the ruleset and the host's routing use
// (lib/exitTopology.ts), so the ui can show whether each one's interface is provisioned yet.
const exitNodes = computed(() => exitTopologyOf(peers.value ?? []).exitNodes.filter((node) => node.peer.id !== props.peer?.id));

/** This peer's own exit link, once converge has allocated it - drives the port hint below. */
const currentLink = computed(() => (props.peer ? exitLinkOf(props.peer) : null));

// Empty string = "allocate one for me". Kept as a string so clearing the input is expressible
// at all; the api takes null for the same meaning.
const exitListenPortInput = ref('');

// Being an exit node and using one are mutually exclusive (the api rejects both) - it would
// be a routing loop, and the two roles need different AllowedIPs.
/** The two arms are one choice, so selecting either clears the other - see lib/peerInvariants.ts. */
const selectExit = (exitPeerId: string | null, viaServer: boolean) => {
	form.exitPeerId = exitPeerId;
	form.exitViaServer = viaServer;
};

const toggleExitNode = () => {
	form.isExitNode = !form.isExitNode;
	if (form.isExitNode) selectExit(null, false);
	else {
		form.exitDns = '';
		exitListenPortInput.value = '';
	}
};

const toggleTag = (tagId: string) => {
	form.tagIds = form.tagIds.includes(tagId) ? form.tagIds.filter((id) => id !== tagId) : [...form.tagIds, tagId];
};

const errors = reactive({
	wgAddress: '',
	isExitNode: '',
	advertisedRoutes: '',
	exitListenPort: '',
	// server-side only: a stale tag id, or an exit node that vanished between load and submit.
	// Present so a field-scoped failure has somewhere to land (see queries/useWrite.ts).
	tagIds: '',
	exitPeerId: '',
	exitViaServer: '',
});

// The per-server state lib/peerInvariants.ts decides against, assembled from what this form
// already has in cache.
const invariantSnapshot = computed(() => ({
	peers: peers.value ?? [],
	tagIds: (tags.value ?? []).map((t) => t.id),
	serverIsExitNode: props.server.isExitNode,
}));

const validate = () => {
	let isValid = true;
	errors.wgAddress = '';
	errors.isExitNode = '';
	errors.advertisedRoutes = '';
	errors.exitListenPort = '';
	errors.tagIds = '';
	errors.exitPeerId = '';
	errors.exitViaServer = '';

	// Range only - whether the port is free depends on every other interface on the host, so
	// that check stays server-side (resolveExitListenPort in wg/peerIntake.ts).
	if (form.isExitNode && exitListenPortInput.value.trim()) {
		const port = Number(exitListenPortInput.value);
		if (!Number.isInteger(port) || port < WG_LISTEN_PORT_MIN || port > WG_LISTEN_PORT_MAX) {
			errors.exitListenPort = `Port must be between ${WG_LISTEN_PORT_MIN} and ${WG_LISTEN_PORT_MAX}, or empty to allocate one.`;
			isValid = false;
		}
	}

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
		exitViaServer: form.exitViaServer,
	});
	if (invariantError) {
		// each rule names the field it is about, so "tags not found" no longer lands on the
		// exit-node checkbox the way it did when this was a bare string
		const field = invariantError.field;
		if (field && field in errors) {
			errors[field as keyof typeof errors] = invariantError.message;
		} else {
			errors.isExitNode = invariantError.message;
		}
		isValid = false;
	}

	// The same two rules the api applies per prefix (checkAdvertisedRoute, lib/peerInvariants.ts),
	// with the same message - this used to restate both by hand. Whether a prefix *overlaps*
	// another peer's advertisement or another interface's range depends on every peer on the
	// host, so that half stays server-side (resolveAdvertisedRoutes in wg/addressing.ts) and now
	// comes back naming this same field.
	const entries = parseCidrList(form.advertisedRoutes);
	for (const entry of entries) {
		const invalid = checkAdvertisedRoute(entry);
		if (invalid) {
			errors.advertisedRoutes = invalid.message;
			isValid = false;
		}
	}

	// Network-align what will be stored, so the input stops showing a value the api would
	// silently rewrite (192.168.1.5/24 -> 192.168.1.0/24).
	if (isValid && entries.length) {
		form.advertisedRoutes = entries.map(normalizeCidr).join(', ');
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
			form.exitViaServer = peer.exitViaServer ?? false;
			form.exitDns = peer.exitDns ?? '';
			form.advertisedRoutes = peer.advertisedRoutes ?? '';
			exitListenPortInput.value = peer.exitListenPort === null ? '' : String(peer.exitListenPort);
			isEditMode.value = true;
		} else {
			isEditMode.value = false;
			form.friendlyName = '';
			form.wgAddress = '';
			form.tagIds = [];
			form.isExitNode = false;
			form.exitPeerId = null;
			form.exitViaServer = false;
			form.exitDns = '';
			form.advertisedRoutes = '';
			exitListenPortInput.value = '';
		}
		errors.wgAddress = '';
		errors.isExitNode = '';
		errors.advertisedRoutes = '';
		errors.exitListenPort = '';
	},
	{ immediate: true },
);

// exitDns and advertisedRoutes are clearable: '' from the input becomes null (clear), which
// `typeof form`'s `string` doesn't allow. exitListenPort is the same idea with a number.
type PeerPayload = Omit<typeof form, 'exitDns' | 'advertisedRoutes'> & { exitDns: string | null; advertisedRoutes: string | null; exitListenPort: number | null };

// The cross-row checks this form cannot make (is the address free, does a prefix overlap
// another peer's, is the udp port taken) all name their field server-side, so they land on the
// same input the client-side rules use rather than in a toast.
const createPeer = useWrite({
	mutationFn: async (data: PeerPayload) => (await eden.api.v1.wg.servers({ id: props.server.id }).peers.post(data)).data,
	summary: 'Failed to create peer',
	invalidate: (qc) => invalidate.afterPeerChange(qc, props.server.id),
	fields: errors,
	onSuccess: () => {
		visible.value = false;
	},
});

const updatePeer = useWrite({
	mutationFn: async (data: PeerPayload) => (props.peer ? (await eden.api.v1.wg.servers({ id: props.server.id }).peers({ peerId: props.peer.id }).patch(data)).data : undefined),
	summary: 'Failed to update peer',
	invalidate: (qc) => invalidate.afterPeerChange(qc, props.server.id),
	fields: errors,
	onSuccess: () => {
		visible.value = false;
	},
});

const handleSubmit = () => {
	if (!validate()) {
		return;
	}
	const data = {
		...form,
		exitDns: form.exitDns || null,
		advertisedRoutes: form.advertisedRoutes || null,
		// only meaningful for an exit node, and empty means "allocate one"
		exitListenPort: form.isExitNode && exitListenPortInput.value.trim() ? Number(exitListenPortInput.value) : null,
	};
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
