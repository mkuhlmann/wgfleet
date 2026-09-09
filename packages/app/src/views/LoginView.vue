<template>
	<div class="flex items-center justify-center pt-16">
		<div class="w-full max-w-sm border border-border rounded-sm bg-surface2 p-6">
			<div class="text-xs uppercase tracking-wide text-muted mb-4">authenticate</div>
			<h1 class="text-lg font-bold text-accent mb-6">wgfleet</h1>
			<form @submit.prevent="handleLogin" class="flex flex-col gap-4">
				<div>
					<label for="token" class="block text-sm text-muted mb-1.5"><span class="text-accent-dim">&gt;</span> administration token</label>
					<BaseInput id="token" v-model="password" type="password" placeholder="paste token" required />
				</div>
				<label class="flex items-center gap-2.5 text-xs text-muted cursor-pointer select-none">
					<input
						type="checkbox"
						v-model="rememberMe"
						class="w-3.5 h-3.5 rounded-xs border border-border bg-bg accent-accent cursor-pointer focus:outline-none focus:border-accent"
					/>
					<span><span class="text-accent-dim">&gt;</span> remember credentials (7 days)</span>
				</label>
				<BaseButton type="submit" :loading="loggingIn" class="w-full">login</BaseButton>
			</form>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import BaseInput from '@app/components/BaseInput.vue';
import BaseButton from '@app/components/BaseButton.vue';
import { useAuthStore } from '@app/stores/auth';
import { useToast } from '@app/composables/useToast';
import { useRouter } from 'vue-router';

const password = ref('');
const rememberMe = ref(true);
const loggingIn = ref(false);
const { add: addToast } = useToast();
const authStore = useAuthStore();
const router = useRouter();

async function handleLogin() {
	loggingIn.value = true;
	try {
		await authStore.login(password.value, rememberMe.value);
		router.push('/servers');
	} catch (err: any) {
		addToast({
			severity: 'error',
			summary: 'Login error',
			detail: err?.message || 'Invalid admin token',
		});
	} finally {
		loggingIn.value = false;
	}
}
</script>
