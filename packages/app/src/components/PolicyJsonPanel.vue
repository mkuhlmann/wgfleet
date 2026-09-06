<template>
	<div class="flex flex-col gap-3">
		<div class="flex justify-between items-center flex-wrap gap-2">
			<small class="text-muted text-xs">the full policy as json - edit and apply to import, or copy for backup/review</small>
			<div class="flex gap-2">
				<BaseButton @click="copyToClipboard" variant="ghost" size="sm">{{ copied ? 'copied' : 'copy' }}</BaseButton>
				<BaseButton @click="revert" variant="ghost" size="sm" :disabled="!isDirty">revert</BaseButton>
				<BaseButton @click="apply" variant="primary" size="sm" :loading="applyMutation.isPending.value" :disabled="!isDirty">apply</BaseButton>
			</div>
		</div>
		<textarea
			v-model="draft"
			spellcheck="false"
			class="w-full h-96 rounded-sm border border-border bg-bg text-text px-3 py-2 text-xs font-mono focus:outline-none focus:border-accent resize-y"
		></textarea>
		<span v-if="error" class="text-down text-xs">{{ error }}</span>
	</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { queryServerPolicy } from '@app/queries/queryPolicy';
import { eden } from '@app/queries/edenClient';
import { useToast } from '@app/composables/useToast';
import BaseButton from './BaseButton.vue';

const props = defineProps<{ serverId: string }>();

const toast = useToast();
const queryClient = useQueryClient();

const { data: policy } = useQuery(queryServerPolicy(props.serverId));

const draft = ref('');
const error = ref('');
const copied = ref(false);

const serverText = computed(() => (policy.value ? JSON.stringify(policy.value, null, 2) : ''));

// seed the draft from server state once, but don't clobber an in-progress edit if a
// background refetch happens to land while the user is typing.
const seeded = ref(false);
watch(
	serverText,
	(text) => {
		if (!seeded.value && text) {
			draft.value = text;
			seeded.value = true;
		}
	},
	{ immediate: true }
);

const isDirty = computed(() => draft.value !== serverText.value);

const revert = () => {
	draft.value = serverText.value;
	error.value = '';
};

const copyToClipboard = async () => {
	await navigator.clipboard.writeText(draft.value);
	copied.value = true;
	setTimeout(() => (copied.value = false), 2000);
};

const invalidateAll = () => {
	queryClient.invalidateQueries({ queryKey: ['serverPolicy', props.serverId] });
	queryClient.invalidateQueries({ queryKey: ['serverTags', props.serverId] });
	queryClient.invalidateQueries({ queryKey: ['serverGrants', props.serverId] });
	queryClient.invalidateQueries({ queryKey: ['serverPeers', props.serverId] });
};

const applyMutation = useMutation({
	mutationFn: async (body: unknown) => {
		const res = await eden.api.v1.wg.servers({ id: props.serverId }).policy.put(body as any);
		return res.data;
	},
	onSuccess: (data) => {
		draft.value = JSON.stringify(data, null, 2);
		invalidateAll();
		toast.add({ severity: 'success', summary: 'Policy applied', life: 3000 });
	},
	onError: (err: Error) => {
		error.value = err.message;
	},
});

const apply = () => {
	error.value = '';
	let parsed: unknown;
	try {
		parsed = JSON.parse(draft.value);
	} catch (e) {
		error.value = 'Invalid JSON: ' + (e as Error).message;
		return;
	}
	applyMutation.mutate(parsed);
};
</script>
