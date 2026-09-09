<template>
	<BaseModal v-model:visible="visible" :header="isEditMode ? 'edit tag' : 'add tag'">
		<form @submit.prevent="handleSubmit" class="flex flex-col gap-5">
			<div class="field">
				<label for="name" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> name</label>
				<BaseInput id="name" v-model="form.name" class="w-full" placeholder="e.g. dev" />
				<small class="text-muted text-xs">lowercase slug, used to reference this tag from grants</small>
				<span v-if="errors.name" class="text-down text-xs block mt-1">{{ errors.name }}</span>
			</div>
			<div class="field">
				<label for="friendlyName" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> friendly name</label>
				<BaseInput id="friendlyName" v-model="form.friendlyName" class="w-full" placeholder="e.g. Developers" />
			</div>
			<div class="flex justify-end gap-2 mt-2">
				<BaseButton @click="visible = false" variant="ghost" type="button">cancel</BaseButton>
				<BaseButton type="submit" variant="primary">
					{{ isEditMode ? 'save changes' : 'add tag' }}
				</BaseButton>
			</div>
		</form>
	</BaseModal>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue';
import { useToast } from '@app/composables/useToast';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import type { PeerTag, ServerPeer } from '@server/db/schema';
import { eden } from '@app/queries/edenClient';
import { invalidate } from '@app/queries/keys';
import BaseButton from './BaseButton.vue';
import BaseInput from './BaseInput.vue';
import BaseModal from './BaseModal.vue';

const toast = useToast();

const props = defineProps<{
	tag?: PeerTag;
	server: ServerPeer;
}>();

const isEditMode = ref(props.tag ? true : false);

const visible = defineModel<boolean>('visible', { required: true });
const queryClient = useQueryClient();

const form = reactive({
	name: '',
	friendlyName: '',
});

const errors = reactive({
	name: '',
});

const nameRegex = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const validate = () => {
	errors.name = '';
	if (!nameRegex.test(form.name)) {
		errors.name = 'lowercase letters, numbers and hyphens only, must start/end with a letter or number.';
		return false;
	}
	return true;
};

watch(
	() => props.tag,
	(tag) => {
		if (tag) {
			form.name = tag.name;
			form.friendlyName = tag.friendlyName ?? '';
			isEditMode.value = true;
		} else {
			isEditMode.value = false;
			form.name = '';
			form.friendlyName = '';
		}
		errors.name = '';
	},
	{ immediate: true }
);

const createTag = useMutation({
	mutationFn: async (data: typeof form) => {
		const res = await eden.api.v1.wg.servers({ id: props.server.id }).tags.post(data);
		return res.data;
	},
	onSuccess: async () => {
		await invalidate.afterTagChange(queryClient, props.server.id);
		visible.value = false;
	},
	onError: (error) => {
		toast.add({
			severity: 'error',
			detail: error.message,
			summary: 'Failed to create tag',
			life: 5000,
		});
	},
});

const updateTag = useMutation({
	mutationFn: async (data: typeof form) => {
		if (!props.tag) return;
		const res = await eden.api.v1.wg.servers({ id: props.server.id }).tags({ tagId: props.tag.id }).patch(data);
		return res.data;
	},
	onSuccess: async () => {
		await invalidate.afterTagChange(queryClient, props.server.id);
		visible.value = false;
	},
	onError: (error) => {
		toast.add({
			severity: 'error',
			detail: error.message,
			summary: 'Failed to update tag',
			life: 5000,
		});
	},
});

const handleSubmit = () => {
	if (!validate()) {
		return;
	}
	if (isEditMode.value) {
		updateTag.mutate(form);
	} else {
		createTag.mutate(form);
	}
};
</script>
