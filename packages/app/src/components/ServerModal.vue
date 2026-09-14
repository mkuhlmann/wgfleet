<template>
	<BaseModal v-model:visible="visible" :header="isEditMode ? 'edit server' : 'add server'" width="lg">
		<!-- Two panes - how the interface is reached, against the addresses it hands out. They stack below md. -->
		<form :id="formId" @submit.prevent="handleSubmit" class="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
			<div class="flex flex-col gap-5">
				<div class="field">
					<label for="friendlyName" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> friendly name</label>
					<BaseInput id="friendlyName" v-model="form.friendlyName" class="w-full" placeholder="e.g. fra-edge-01" />
					<small class="text-muted text-xs">a memorable name for this server</small>
				</div>
				<div class="field">
					<label for="interfaceName" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> interface name</label>
					<BaseInput id="interfaceName" v-model="form.interfaceName" class="w-full" required placeholder="e.g. wg0" />
					<small class="text-muted text-xs">the network interface name. must be alphanumeric (max 15 chars)</small>
					<span v-if="errors.interfaceName" class="text-down text-xs block mt-1">{{ errors.interfaceName }}</span>
				</div>
				<div class="field">
					<label for="wgEndpoint" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> wireguard endpoint</label>
					<BaseInput id="wgEndpoint" v-model="form.wgEndpoint" class="w-full" required placeholder="e.g. vpn.example.com:51820" />
					<small class="text-muted text-xs">the public ip or domain and port where this server is reachable</small>
				</div>
				<div class="field">
					<label for="wgListenPort" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> listen port</label>
					<BaseInput id="wgListenPort" v-model.number="form.wgListenPort" type="number" class="w-full" required placeholder="51820" />
					<small class="text-muted text-xs">the udp port wireguard will listen on (1-65535)</small>
					<span v-if="errors.wgListenPort" class="text-down text-xs block mt-1">{{ errors.wgListenPort }}</span>
				</div>
			</div>

			<div class="flex flex-col gap-5 md:border-l md:border-border md:pl-6">
				<!-- the pane divider is a vertical hairline on md+, so stacked it needs the horizontal one -->
				<div class="rule-line md:hidden"></div>

				<div class="field">
					<label for="wgAddress" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> wireguard address</label>
					<BaseInput id="wgAddress" v-model="form.wgAddress" class="w-full" required placeholder="e.g. 10.8.0.1" />
					<small class="text-muted text-xs">the internal ip address for the wireguard interface</small>
					<span v-if="errors.wgAddress" class="text-down text-xs block mt-1">{{ errors.wgAddress }}</span>
				</div>
				<div class="field">
					<label for="cidrRange" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> cidr range</label>
					<BaseInput id="cidrRange" v-model="form.cidrRange" class="w-full" required placeholder="e.g. 10.8.0.0/24" />
					<small class="text-muted text-xs">the subnet for the vpn network. clients get ips from this range</small>
					<span v-if="errors.cidrRange" class="text-down text-xs block mt-1">{{ errors.cidrRange }}</span>
				</div>
				<div class="field">
					<label for="reservedIps" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> reserved ips</label>
					<BaseInput id="reservedIps" v-model.number="form.reservedIps" type="number" class="w-full" required placeholder="50" />
					<small class="text-muted text-xs">number of ips to reserve at the start of the subnet range</small>
				</div>
				<div class="field">
					<label for="dns" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> dns</label>
					<BaseInput id="dns" v-model="form.dns" class="w-full" placeholder="leave empty to omit" />
					<small class="text-muted text-xs">resolver handed to clients as <span class="text-text">DNS =</span> in their config. an exit node can override it for its own clients</small>
				</div>
			</div>

			<div class="md:col-span-2">
				<div class="rule-line mb-5"></div>
				<div class="field">
					<button type="button" class="flex items-center gap-2 text-sm text-text" @click="form.isExitNode = !form.isExitNode">
						<span class="text-accent-dim">{{ form.isExitNode ? '[x]' : '[ ]' }}</span>
						<span><span class="text-accent-dim">&gt;</span> offer this server as an exit node</span>
					</button>
					<small class="text-muted text-xs block mt-1">
						lets clients send their internet traffic out <span class="text-text">this host's</span> own uplink, masqueraded. the cheapest exit there is - no extra interface, no extra udp port, and the client keeps dialing this server's endpoint. a
						peer exit node needs its own port; this one does not.
					</small>
					<small class="text-muted text-xs block mt-1">this grants nobody anything on its own - each client still has to select it under <span class="text-text">internet access</span> in its own dialog.</small>
				</div>
			</div>
		</form>

		<template #footer>
			<BaseButton @click="visible = false" variant="ghost" type="button">cancel</BaseButton>
			<BaseButton :form="formId" type="submit" variant="primary">
				{{ isEditMode ? 'save changes' : 'add server' }}
			</BaseButton>
		</template>
	</BaseModal>
</template>

<script setup lang="ts">
import { ref, reactive, watch, useId } from 'vue';
import { useWrite } from '@app/queries/useWrite';
import type { ServerPeer } from '@server/db/schema';
import { checkServerInvariants } from '@server/lib/serverInvariants';
import { eden } from '@app/queries/edenClient';
import { invalidate } from '@app/queries/keys';
import BaseButton from './BaseButton.vue';
import BaseInput from './BaseInput.vue';
import BaseModal from './BaseModal.vue';

const props = defineProps<{
	server?: ServerPeer;
	/** every server on this host - the cross-row half of lib/serverInvariants.ts needs them */
	servers?: Pick<ServerPeer, 'id' | 'interfaceName' | 'wgListenPort'>[];
}>();

// The submit button lives in the modal footer, outside the <form> - see PeerModal.vue.
const formId = useId();

const isEditMode = ref(props.server ? true : false);

const visible = defineModel<boolean>('visible', { required: true });

const form = reactive({
	friendlyName: '',
	interfaceName: '',
	wgAddress: '',
	wgEndpoint: '',
	wgListenPort: 51820,
	cidrRange: '10.0.0.0/24',
	reservedIps: 50,
	dns: '',
	isExitNode: false,
});

const errors = reactive({
	interfaceName: '',
	wgAddress: '',
	wgListenPort: '',
	cidrRange: '',
	wgEndpoint: '',
	reservedIps: '',
});

/**
 * The same function the api decides with (server/src/lib/serverInvariants.ts).
 *
 * This form used to hand-roll four field-format checks, one of which (wgAddress against
 * IPV4_ADDRESS_REGEX) the api had no equivalent for at all - and since that regex deliberately
 * permits a trailing /prefix that the api's containment check then refused, a value this form
 * called valid could come back 400. The two cross-row rules it could never state - a port
 * another server already listens on, an address outside the range - are checkable here now,
 * against the server list already in cache.
 */
const validate = () => {
	for (const key of Object.keys(errors) as (keyof typeof errors)[]) errors[key] = '';

	const invalid = checkServerInvariants({ servers: props.servers ?? [] }, props.server ?? null, form);
	if (invalid) {
		const field = invalid.field;
		if (field && field in errors) {
			errors[field as keyof typeof errors] = invalid.message;
		}
		return false;
	}

	return true;
};

watch(
	() => props.server,
	(server) => {
		if (server) {
			form.friendlyName = server.friendlyName ?? '';
			form.interfaceName = server.interfaceName ?? '';
			form.wgAddress = server.wgAddress ?? '';
			form.wgEndpoint = server.wgEndpoint;
			form.wgListenPort = server.wgListenPort;
			form.cidrRange = server.cidrRange ?? '10.0.0.0/24';
			form.reservedIps = server.reservedIps ?? 50;
			form.dns = server.dns ?? '';
			form.isExitNode = server.isExitNode ?? false;
			isEditMode.value = true;
		} else {
			isEditMode.value = false;
			// Reset form defaults
			form.friendlyName = '';
			form.interfaceName = '';
			form.wgAddress = '';
			form.wgEndpoint = '';
			form.wgListenPort = 51820;
			form.cidrRange = '10.0.0.0/24';
			form.reservedIps = 50;
			form.dns = '';
			form.isExitNode = false;
		}
		// Clear errors when opening/changing server
		errors.interfaceName = '';
		errors.wgAddress = '';
		errors.wgListenPort = '';
		errors.cidrRange = '';
	},
	{ immediate: true },
);

// dns is the one clearable field, and create/patch differ on how: the create schema takes
// `t.Optional(t.String())` (omit it) while patch takes `t.Optional(t.Nullable(t.String()))`
// (null clears it). Two payload types rather than one, so the difference stays type-checked -
// the app types these straight off the server's route schemas, with no codegen in between.
type CreateServerPayload = Omit<typeof form, 'dns'> & { dns?: string };
type UpdateServerPayload = Omit<typeof form, 'dns'> & { dns: string | null };

// `fields: errors` routes a field-scoped refusal onto the input that caused it - the server
// names the field (server/src/lib/failure.ts), so `wgListenPort already in use` lands on the
// port input rather than in a toast the form cannot act on.
const createServer = useWrite({
	mutationFn: async (data: CreateServerPayload) => (await eden.api.v1.wg.servers.post(data)).data,
	summary: 'Failed to create server',
	invalidate: invalidate.afterServerChange,
	fields: errors,
	onSuccess: () => {
		visible.value = false;
	},
});

const updateServer = useWrite({
	mutationFn: async (data: UpdateServerPayload) => (props.server ? (await eden.api.v1.wg.servers({ id: props.server.id }).patch(data)).data : undefined),
	summary: 'Failed to update server',
	invalidate: invalidate.afterServerChange,
	fields: errors,
	onSuccess: () => {
		visible.value = false;
	},
});

const handleSubmit = () => {
	if (!validate()) {
		return;
	}
	if (isEditMode.value) {
		// null clears it server-side; '' would be stored as an empty string
		updateServer.mutate({ ...form, dns: form.dns || null });
	} else {
		createServer.mutate({ ...form, dns: form.dns || undefined });
	}
};
</script>
