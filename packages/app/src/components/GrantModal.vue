<template>
	<BaseModal v-model:visible="visible" :header="isEditMode ? 'edit grant' : 'add grant'">
		<form @submit.prevent="handleSubmit" class="flex flex-col gap-5">
			<div class="field">
				<label class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> action</label>
				<div class="flex gap-2">
					<button
						type="button"
						class="flex-1 rounded-sm border px-3 py-2 text-sm transition-colors"
						:class="form.action === 'allow' ? 'border-up text-up bg-surface2' : 'border-border text-muted hover:border-accent-dim'"
						@click="form.action = 'allow'"
					>
						allow
					</button>
					<button
						type="button"
						class="flex-1 rounded-sm border px-3 py-2 text-sm transition-colors"
						:class="form.action === 'deny' ? 'border-down text-down bg-surface2' : 'border-border text-muted hover:border-accent-dim'"
						@click="form.action = 'deny'"
					>
						deny
					</button>
				</div>
			</div>

			<div class="field">
				<label class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> source</label>
				<div class="flex gap-2">
					<select v-model="form.srcKind" class="w-32 shrink-0 rounded-sm border border-border bg-bg text-text px-3 py-2 text-sm focus:outline-none focus:border-accent">
						<option value="tag">tag</option>
						<option value="peer">peer</option>
					</select>
					<select v-if="form.srcKind === 'tag'" v-model="form.srcTagId" class="flex-1 rounded-sm border border-border bg-bg text-text px-3 py-2 text-sm focus:outline-none focus:border-accent">
						<option value="" disabled>select a tag</option>
						<option v-for="tag in tags" :key="tag.id" :value="tag.id">{{ tag.friendlyName ?? tag.name }}</option>
					</select>
					<select v-else v-model="form.srcPeerId" class="flex-1 rounded-sm border border-border bg-bg text-text px-3 py-2 text-sm focus:outline-none focus:border-accent">
						<option value="" disabled>select a peer</option>
						<option v-for="peer in peers" :key="peer.id" :value="peer.id">{{ peer.friendlyName ?? peer.id }}</option>
					</select>
				</div>
				<small class="text-muted text-xs">a peer-scoped source overrides tag-scoped grants when placed above them</small>
			</div>

			<div class="field">
				<label class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> destination</label>
				<div class="flex gap-2">
					<select v-model="form.dstKind" class="w-32 shrink-0 rounded-sm border border-border bg-bg text-text px-3 py-2 text-sm focus:outline-none focus:border-accent">
						<option value="tag">tag</option>
						<option value="peer">peer</option>
						<option value="cidr">cidr</option>
						<option value="server">server</option>
						<option value="any">any</option>
					</select>
					<select v-if="form.dstKind === 'tag'" v-model="form.dstTagId" class="flex-1 rounded-sm border border-border bg-bg text-text px-3 py-2 text-sm focus:outline-none focus:border-accent">
						<option value="" disabled>select a tag</option>
						<option v-for="tag in tags" :key="tag.id" :value="tag.id">{{ tag.friendlyName ?? tag.name }}</option>
					</select>
					<select v-else-if="form.dstKind === 'peer'" v-model="form.dstPeerId" class="flex-1 rounded-sm border border-border bg-bg text-text px-3 py-2 text-sm focus:outline-none focus:border-accent">
						<option value="" disabled>select a peer</option>
						<option v-for="peer in peers" :key="peer.id" :value="peer.id">{{ peer.friendlyName ?? peer.id }}</option>
					</select>
					<BaseInput v-else-if="form.dstKind === 'cidr'" v-model="form.dstCidr" class="flex-1" placeholder="e.g. 192.168.50.0/24" />
					<div v-else class="flex-1 flex items-center text-sm text-muted">
						{{ dstKindHintText }}
					</div>
				</div>
				<span v-if="errors.dstCidr" class="text-down text-xs block mt-1">{{ errors.dstCidr }}</span>
			</div>

			<div class="field">
				<label class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> protocol / ports</label>
				<div class="flex gap-2">
					<select v-model="form.protocol" class="w-32 shrink-0 rounded-sm border border-border bg-bg text-text px-3 py-2 text-sm focus:outline-none focus:border-accent">
						<option value="any">any</option>
						<option value="tcp">tcp</option>
						<option value="udp">udp</option>
						<option value="icmp">icmp</option>
					</select>
					<BaseInput v-if="form.protocol === 'tcp' || form.protocol === 'udp'" v-model="form.ports" class="flex-1" placeholder="e.g. 22, 8000-8100 (leave empty for all ports)" />
				</div>
				<span v-if="errors.ports" class="text-down text-xs block mt-1">{{ errors.ports }}</span>
			</div>

			<div class="field">
				<label for="comment" class="mb-1.5 text-sm text-muted block"><span class="text-accent-dim">&gt;</span> comment</label>
				<BaseInput id="comment" v-model="form.comment" class="w-full" placeholder="optional, shown in the firewall ruleset" />
			</div>

			<div class="flex justify-end gap-2 mt-2">
				<BaseButton @click="visible = false" variant="ghost" type="button">cancel</BaseButton>
				<BaseButton type="submit" variant="primary">
					{{ isEditMode ? 'save changes' : 'add grant' }}
				</BaseButton>
			</div>
		</form>
	</BaseModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { PeerTag, Peer, PolicyGrant } from '@server/db/schema';
import BaseButton from './BaseButton.vue';
import BaseInput from './BaseInput.vue';
import BaseModal from './BaseModal.vue';

export type GrantDraft = {
	enabled: boolean;
	action: 'allow' | 'deny';
	srcKind: 'tag' | 'peer';
	srcTagId?: string;
	srcPeerId?: string;
	dstKind: 'tag' | 'peer' | 'cidr' | 'server' | 'any';
	dstTagId?: string;
	dstPeerId?: string;
	dstCidr?: string;
	protocol: 'any' | 'tcp' | 'udp' | 'icmp';
	ports?: string;
	comment?: string;
};

const props = defineProps<{
	tags: PeerTag[];
	peers: Pick<Peer, 'id' | 'friendlyName'>[];
	grant?: PolicyGrant;
}>();

const emit = defineEmits<{
	(e: 'save', grant: GrantDraft): void;
}>();

const isEditMode = ref(props.grant ? true : false);
const visible = defineModel<boolean>('visible', { required: true });

const emptyForm = (): GrantDraft => ({
	enabled: true,
	action: 'allow',
	srcKind: 'tag',
	srcTagId: props.tags[0]?.id,
	dstKind: 'tag',
	dstTagId: props.tags[0]?.id,
	protocol: 'any',
	ports: '',
	comment: '',
});

const form = reactive<GrantDraft>(emptyForm());

const errors = reactive({ dstCidr: '', ports: '' });

const dstKindHint: Record<string, string> = {
	server: "the gateway's own tunnel address (dns, management api)",
	any: 'matches every destination on this interface. the internet is not one of them - that is an exit node, not a grant',
};

const dstKindHintText = computed(() => dstKindHint[form.dstKind] ?? '');

// ipv4-only - mirrors wg/firewall.ts isIpv4Cidr
const isIpv4Cidr = (value: string) => /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[1-2][0-9]|3[0-2])$/.test(value);
// mirrors api/policy.ts portsRegex + range validation
const isValidPorts = (value: string) => {
	if (!/^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/.test(value)) return false;
	for (const entry of value.split(',')) {
		const [loStr, hiStr] = entry.split('-');
		const lo = Number(loStr);
		const hi = hiStr !== undefined ? Number(hiStr) : lo;
		if (lo < 1 || lo > 65535 || hi < 1 || hi > 65535 || lo > hi) return false;
	}
	return true;
};

const validate = () => {
	errors.dstCidr = '';
	errors.ports = '';
	let isValid = true;

	if (form.dstKind === 'cidr' && (!form.dstCidr || !isIpv4Cidr(form.dstCidr))) {
		errors.dstCidr = 'must be a valid ipv4 cidr, e.g. 192.168.50.0/24';
		isValid = false;
	}

	if (form.ports && form.ports.trim() && !isValidPorts(form.ports.trim())) {
		errors.ports = 'must be a comma-separated list of ports/ranges, e.g. 22,8000-8100';
		isValid = false;
	}

	return isValid;
};

watch(
	() => props.grant,
	(grant) => {
		if (grant) {
			Object.assign(form, {
				enabled: grant.enabled,
				action: grant.action,
				srcKind: grant.srcKind,
				srcTagId: grant.srcTagId ?? undefined,
				srcPeerId: grant.srcPeerId ?? undefined,
				dstKind: grant.dstKind,
				dstTagId: grant.dstTagId ?? undefined,
				dstPeerId: grant.dstPeerId ?? undefined,
				dstCidr: grant.dstCidr ?? '',
				protocol: grant.protocol,
				ports: grant.ports ?? '',
				comment: grant.comment ?? '',
			});
			isEditMode.value = true;
		} else {
			Object.assign(form, emptyForm());
			isEditMode.value = false;
		}
		errors.dstCidr = '';
		errors.ports = '';
	},
	{ immediate: true },
);

const handleSubmit = () => {
	if (!validate()) return;
	emit('save', { ...form });
	visible.value = false;
};
</script>
