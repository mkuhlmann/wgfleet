<template>
	<BaseModal v-model:visible="visible" :header="isEditMode ? 'edit tag' : 'add tag'">
		<form :id="formId" @submit.prevent="handleSubmit" class="flex flex-col gap-5">
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
		</form>

		<template #footer>
			<BaseButton @click="visible = false" variant="ghost" type="button">cancel</BaseButton>
			<BaseButton :form="formId" type="submit" variant="primary">
				{{ isEditMode ? 'save changes' : 'add tag' }}
			</BaseButton>
		</template>
	</BaseModal>
</template>

<script setup lang="ts">
import { ref, reactive, watch, useId } from 'vue';
import { useWrite } from '@app/queries/useWrite';
import type { PeerTag, ServerPeer } from '@server/db/schema';
import { checkTagInvariants } from '@server/lib/tagInvariants';
import { eden } from '@app/queries/edenClient';
import { invalidate } from '@app/queries/keys';
import BaseButton from './BaseButton.vue';
import BaseInput from './BaseInput.vue';
import BaseModal from './BaseModal.vue';

const props = defineProps<{
	tag?: PeerTag;
	server: ServerPeer;
	/** every tag on this server - the uniqueness half of lib/tagInvariants.ts needs them */
	tags?: PeerTag[];
}>();

// The submit button lives in the modal footer, outside the <form> - see PeerModal.vue.
const formId = useId();

const isEditMode = ref(props.tag ? true : false);

const visible = defineModel<boolean>('visible', { required: true });

const form = reactive({
	name: '',
	friendlyName: '',
});

const errors = reactive({
	name: '',
});

// The same function the api decides with (server/src/lib/tagInvariants.ts), including the
// uniqueness check - which this form could not make before and which therefore always cost a
// round trip. The name regex used to be a byte-identical second copy of the api's, with no
// import between them.
const validate = () => {
	errors.name = '';

	const invalid = checkTagInvariants({ tags: props.tags ?? [] }, props.tag ?? null, { name: form.name });
	if (invalid) {
		errors.name = invalid.message;
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
	{ immediate: true },
);

const createTag = useWrite({
	mutationFn: async (data: typeof form) => (await eden.api.v1.wg.servers({ id: props.server.id }).tags.post(data)).data,
	summary: 'Failed to create tag',
	invalidate: (qc) => invalidate.afterTagChange(qc, props.server.id),
	// a duplicate name comes back naming `name`, so it lands on the name input
	fields: errors,
	onSuccess: () => {
		visible.value = false;
	},
});

const updateTag = useWrite({
	mutationFn: async (data: typeof form) => (props.tag ? (await eden.api.v1.wg.servers({ id: props.server.id }).tags({ tagId: props.tag.id }).patch(data)).data : undefined),
	summary: 'Failed to update tag',
	invalidate: (qc) => invalidate.afterTagChange(qc, props.server.id),
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
		updateTag.mutate(form);
	} else {
		createTag.mutate(form);
	}
};
</script>
