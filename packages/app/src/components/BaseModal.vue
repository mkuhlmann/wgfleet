<template>
	<Teleport to="body">
		<Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="opacity-100" leave-to-class="opacity-0">
			<div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/70" @click="closeOnBackdropClick">
				<!--
					The shell is bounded by the viewport (`max-h-full` against the padded flex parent) and lays
					its three rows out vertically, so only the content row scrolls. Without the bound a tall
					modal overflowed a centered flex container in both directions, which clips the top - i.e.
					the header and the first fields became unreachable rather than scrollable.
				-->
				<div :class="['flex max-h-full w-full flex-col bg-surface2 border border-border rounded-sm shadow-2xl overflow-hidden', widthClasses[width]]" @click.stop>
					<!-- Header -->
					<div class="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between gap-3">
						<h3 class="text-sm font-semibold text-text uppercase tracking-wide"><span class="text-muted">///</span> {{ header }}</h3>
						<button @click="close" class="text-muted hover:text-accent transition-colors focus:outline-none text-sm" aria-label="Close">[x]</button>
					</div>

					<!-- Content -->
					<div class="min-h-0 flex-1 overflow-y-auto p-5 text-text">
						<slot />
					</div>

					<!-- Footer -->
					<div v-if="$slots.footer" class="shrink-0 px-5 py-3 bg-bg border-t border-border flex justify-end gap-2">
						<slot name="footer" />
					</div>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>

<script setup lang="ts">
const props = withDefaults(
	defineProps<{
		visible: boolean;
		header?: string;
		closeOnBackdrop?: boolean;
		/** `sm` is the single-column default; `md`/`lg` are for forms laid out in two columns. */
		width?: 'sm' | 'md' | 'lg';
	}>(),
	{
		closeOnBackdrop: true,
		width: 'sm',
	},
);

const widthClasses = {
	sm: 'max-w-lg',
	md: 'max-w-2xl',
	lg: 'max-w-4xl',
};

const emit = defineEmits<{
	(e: 'update:visible', value: boolean): void;
	(e: 'close'): void;
}>();

const close = () => {
	emit('update:visible', false);
	emit('close');
};

const closeOnBackdropClick = () => {
	if (props.closeOnBackdrop) {
		close();
	}
};
</script>
