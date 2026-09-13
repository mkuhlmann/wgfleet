import { useMutation, useQueryClient, type QueryClient } from '@tanstack/vue-query';
import { ref, type Ref } from 'vue';
import { useToast } from '@app/composables/useToast';
import { ApiError } from './edenClient';

/**
 * One write, end to end: send it, report what happened, invalidate what it made stale.
 *
 * `queries/keys.ts` centralised *what goes stale* and stopped there. Nothing centralised *how a
 * write reports failure*, so all eleven write paths re-decided it - eight repeated the same
 * eighteen lines, two disagreed about where the message lands, and the remaining three (all of
 * them destructive: delete a peer, delete a tag, reset traffic) had no error path at all and
 * failed as an unhandled rejection with nothing on screen.
 *
 * Failure routing, in order:
 *  - a field-scoped `ApiError` whose `field` matches a key of `fields` lands on that input;
 *  - otherwise it goes wherever `report` says.
 *
 * The field only exists because the server now says which one it refused (server/src/lib/
 * failure.ts) instead of flattening every rule to a string.
 */
export type WriteOptions<TArgs, TResult> = {
	/** the eden call. Throws an ApiError on any status >= 400 - see queries/edenClient.ts. */
	mutationFn: (args: TArgs) => Promise<TResult>;
	/** shown as the toast title, or above an inline panel */
	summary: string;
	/** the fan-out from queries/keys.ts */
	invalidate?: (queryClient: QueryClient) => unknown;
	/** form errors a field-scoped failure is routed into rather than toasted */
	fields?: Record<string, string>;
	/** where a failure with no matching field goes. Inline surfaces it on `error` instead. */
	report?: 'toast' | 'inline';
	onSuccess?: (result: TResult) => void;
};

export type Write<TArgs, TResult> = ReturnType<typeof useMutation<TResult, Error, TArgs>> & {
	/**
	 * The last failure that had nowhere better to go, as text - only populated under
	 * `report: 'inline'`. Named apart from vue-query's own `error` (an `Error | null`) because
	 * this is the message a template renders.
	 */
	inlineError: Ref<string>;
};

export function useWrite<TArgs, TResult>(options: WriteOptions<TArgs, TResult>): Write<TArgs, TResult> {
	const queryClient = useQueryClient();
	const toast = useToast();
	const inlineError = ref('');

	const mutation = useMutation<TResult, Error, TArgs>({
		mutationFn: options.mutationFn,
		onMutate: () => {
			inlineError.value = '';
		},
		onSuccess: async (result) => {
			await options.invalidate?.(queryClient);
			options.onSuccess?.(result);
		},
		onError: (cause) => {
			const field = cause instanceof ApiError ? cause.field : undefined;

			if (field && options.fields && field in options.fields) {
				options.fields[field] = cause.message;
				return;
			}

			if (options.report === 'inline') {
				inlineError.value = cause.message;
				return;
			}

			toast.add({ severity: 'error', summary: options.summary, detail: cause.message });
		},
	});

	return Object.assign(mutation, { inlineError });
}
