<template>
	<component
		:is="as"
		:type="as === 'button' ? 'button' : undefined"
		:class="[
			'inline-flex items-center justify-center gap-2 rounded-sm font-semibold tracking-wide whitespace-nowrap transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
			variantClasses[variant],
			sizeClasses[size],
			{ 'opacity-50 cursor-not-allowed': disabled || loading },
		]"
		:disabled="disabled || loading"
		v-bind="$attrs"
	>
		<span aria-hidden="true">[</span>
		<svg v-if="loading" class="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
			<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
			<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
		</svg>
		<slot name="icon-left" />
		<slot />
		<slot name="icon-right" />
		<span aria-hidden="true">]</span>
	</component>
</template>

<script setup lang="ts">
interface Props {
	as?: string | object;
	variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
	size?: 'sm' | 'md' | 'lg';
	disabled?: boolean;
	loading?: boolean;
}

withDefaults(defineProps<Props>(), {
	as: 'button',
	variant: 'primary',
	size: 'md',
	disabled: false,
	loading: false,
});

const variantClasses = {
	primary: 'bg-accent text-bg hover:bg-accent/90 border border-accent',
	secondary: 'bg-transparent text-accent border border-accent-dim hover:border-accent hover:bg-surface2',
	danger: 'bg-transparent text-down border border-down/40 hover:border-down hover:bg-surface2',
	ghost: 'bg-transparent text-muted border border-transparent hover:text-text hover:border-border',
};

const sizeClasses = {
	sm: 'text-xs px-2.5 py-1.5',
	md: 'text-sm px-3.5 py-2',
	lg: 'text-base px-5 py-2.5',
};
</script>
