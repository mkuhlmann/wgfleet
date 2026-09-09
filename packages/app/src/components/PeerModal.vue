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
					<button
						v-for="tag in tags"
						:key="tag.id"
						type="button"
						class="flex items-center gap-2 text-sm text-text"
						@click="toggleTag(tag.id)"
					>
						<span class="text-accent-dim">{{ form.tagIds.includes(tag.id) ? '[x]' : '[ ]' }}</span>
						<span>{{ tag.friendlyName ?? tag.name }}</span>
					</button>
				</div>
				<small class="text-muted text-xs">restricts reachability to what the policy's grants allow. leave all unset for unrestricted access</small>
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
import { ref, reactive, watch } from 'vue';
import { useToast } from '@app/composables/useToast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { Peer, ServerPeer } from '@server/db/schema';
import { IPV4_ADDRESS_REGEX } from '@server/lib/validation';
import { eden } from '@app/queries/edenClient';
import { queryServerTags } from '@app/queries/queryPolicy';
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

const form = reactive<{
	friendlyName?: string;
	wgAddress?: string;
	tagIds: string[];
}>({
	friendlyName: '',
	wgAddress: '',
	tagIds: [],
});

const toggleTag = (tagId: string) => {
	form.tagIds = form.tagIds.includes(tagId) ? form.tagIds.filter((id) => id !== tagId) : [...form.tagIds, tagId];
};

const errors = reactive({
	wgAddress: '',
});

const validate = () => {
	let isValid = true;
	errors.wgAddress = '';

	if (form.wgAddress) {
		if (!IPV4_ADDRESS_REGEX.test(form.wgAddress)) {
			errors.wgAddress = 'Invalid IP address format. WireGuard peer addresses are IPv4 only.';
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
			isEditMode.value = true;
		} else {
			isEditMode.value = false;
			form.friendlyName = '';
			form.wgAddress = '';
			form.tagIds = [];
		}
		errors.wgAddress = '';
	},
	{ immediate: true }
);

const createPeer = useMutation({
	mutationFn: async (data: typeof form) => {
		const res = await eden.api.v1.wg.servers({ id: props.server.id }).peers.post(data);
		return res.data;
	},
	onSuccess: () => {
		queryClient.invalidateQueries({ queryKey: ['serverPeers', props.server.id] });
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
	mutationFn: async (data: typeof form) => {
		if (!props.peer) return;
		const res = await eden.api.v1.wg.servers({ id: props.server.id }).peers({ peerId: props.peer.id }).patch(data);
		return res.data;
	},
	onSuccess: () => {
		queryClient.invalidateQueries({ queryKey: ['serverPeers', props.server.id] });
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
	const data = { ...form };
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
