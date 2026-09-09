<template>
	<BaseModal v-model:visible="visible" :header="isEditMode ? 'edit server' : 'add server'">
		<form @submit.prevent="handleSubmit" class="flex flex-col gap-5">
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
				<label for="wgAddress" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> wireguard address</label>
				<BaseInput id="wgAddress" v-model="form.wgAddress" class="w-full" required placeholder="e.g. 10.8.0.1" />
				<small class="text-muted text-xs">the internal ip address for the wireguard interface</small>
				<span v-if="errors.wgAddress" class="text-down text-xs block mt-1">{{ errors.wgAddress }}</span>
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
				<button type="button" class="flex items-center gap-2 text-sm text-text" @click="form.enableNat = !form.enableNat">
					<span class="text-accent-dim">{{ form.enableNat ? '[x]' : '[ ]' }}</span>
					<span><span class="text-accent-dim">&gt;</span> enable nat</span>
				</button>
				<small class="text-muted text-xs block mt-1">masquerade traffic leaving this subnet to the internet. required for any policy group's "internet" grant to actually work</small>
			</div>
			<div class="flex justify-end gap-2 mt-2">
				<BaseButton @click="visible = false" variant="ghost" type="button">cancel</BaseButton>
				<BaseButton type="submit" variant="primary">
					{{ isEditMode ? 'save changes' : 'add server' }}
				</BaseButton>
			</div>
		</form>
	</BaseModal>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue';
import { useToast } from '@app/composables/useToast';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import type { ServerPeer } from '@server/db/schema';
import { CIDR_REGEX, INTERFACE_NAME_REGEX, IPV4_ADDRESS_REGEX, WG_LISTEN_PORT_MAX, WG_LISTEN_PORT_MIN } from '@server/lib/validation';
import { eden } from '@app/queries/edenClient';
import { invalidate } from '@app/queries/keys';
import BaseButton from './BaseButton.vue';
import BaseInput from './BaseInput.vue';
import BaseModal from './BaseModal.vue';

const props = defineProps<{
	server?: ServerPeer;
}>();

const toast = useToast();

const isEditMode = ref(props.server ? true : false);

const visible = defineModel<boolean>('visible', { required: true });
const queryClient = useQueryClient();

const form = reactive({
	friendlyName: '',
	interfaceName: '',
	wgAddress: '',
	wgEndpoint: '',
	wgListenPort: 51820,
	cidrRange: '10.0.0.0/24',
	reservedIps: 50,
	enableNat: false,
});

const errors = reactive({
	interfaceName: '',
	wgAddress: '',
	wgListenPort: '',
	cidrRange: '',
});

const validate = () => {
	let isValid = true;
	errors.interfaceName = '';
	errors.wgAddress = '';
	errors.wgListenPort = '';
	errors.cidrRange = '';

	// Interface Name validation
	if (!INTERFACE_NAME_REGEX.test(form.interfaceName)) {
		errors.interfaceName = 'Invalid interface name. Must be 1-15 alphanumeric characters (allows _, =, +, ., -).';
		isValid = false;
	}

	// WireGuard Address validation
	if (!IPV4_ADDRESS_REGEX.test(form.wgAddress)) {
		errors.wgAddress = 'Invalid WireGuard Address. Must be a valid IP address (e.g., 10.8.0.1).';
		isValid = false;
	}

	// Listen Port validation
	if (form.wgListenPort < WG_LISTEN_PORT_MIN || form.wgListenPort > WG_LISTEN_PORT_MAX) {
		errors.wgListenPort = `Port must be between ${WG_LISTEN_PORT_MIN} and ${WG_LISTEN_PORT_MAX}.`;
		isValid = false;
	}

	// CIDR Range validation
	if (!CIDR_REGEX.test(form.cidrRange)) {
		errors.cidrRange = 'Invalid CIDR range (e.g., 10.8.0.0/24).';
		isValid = false;
	}

	return isValid;
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
			form.enableNat = server.enableNat ?? false;
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
			form.enableNat = false;
		}
		// Clear errors when opening/changing server
		errors.interfaceName = '';
		errors.wgAddress = '';
		errors.wgListenPort = '';
		errors.cidrRange = '';
	},
	{ immediate: true }
);

const createServer = useMutation({
	mutationFn: async (data: typeof form) => {
		const res = await eden.api.v1.wg.servers.post(data);
		return res.data;
	},
	onSuccess: async () => {
		await invalidate.afterServerChange(queryClient);
		visible.value = false;
	},
	onError: (error) => {
		toast.add({
			severity: 'error',
			detail: error.message,
			summary: 'Failed to create server',
			life: 5000,
		});
	},
});

const updateServer = useMutation({
	mutationFn: async (data: typeof form) => {
		if (!props.server) return;
		const res = await eden.api.v1.wg.servers({ id: props.server?.id }).patch(data);
		return res.data;
	},
	onSuccess: async () => {
		await invalidate.afterServerChange(queryClient);
		visible.value = false;
	},
	onError: (error) => {
		toast.add({
			severity: 'error',
			detail: error.message,
			summary: 'Failed to update server',
			life: 5000,
		});
	},
});

const handleSubmit = () => {
	if (!validate()) {
		return;
	}
	if (isEditMode.value) {
		updateServer.mutate(form);
	} else {
		createServer.mutate(form);
	}
};
</script>
