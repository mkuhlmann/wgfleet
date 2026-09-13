/**
 * One rejected write, as a value.
 *
 * Every rule in this codebase that can refuse a request - address resolution, the peer
 * invariants, advertised-route overlap, grant and server validation - returns one of these, and
 * api/failure.ts is the only place that turns it into an http response. It used to be a bare
 * string: the modules produced structure (which rule, about which field), `status(400, message)`
 * flattened it at the seam, and the frontend then guessed the structure back from the text -
 * which is why every failure in the peer form landed on the same input regardless of cause.
 *
 * Shared with the app (`packages/app` imports server code directly - see CLAUDE.md), so the
 * form that submits a field and the rule that rejects it name it identically.
 */
export type Failure = {
	/** shown to the operator as-is */
	message: string;
	/**
	 * The request property this is about, spelled exactly as the request body spells it, so a
	 * form can put the message on the input that caused it. Omitted when the failure is about
	 * the request as a whole (a missing row, an unauthorized caller).
	 */
	field?: string;
};

export const failure = (message: string, field?: string): Failure => (field === undefined ? { message } : { message, field });

/** The shape every failing response carries. Kept alongside `Failure` so the two cannot drift. */
export type FailureBody = Failure;
