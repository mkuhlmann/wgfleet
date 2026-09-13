import { status, t } from 'elysia';
import type { Failure } from '@server/lib/failure';

/**
 * The one place a `Failure` (lib/failure.ts) becomes an http response, and the one shape an
 * error body ever has.
 *
 * There used to be two: TypeBox schema violations came back as Elysia's own json (`property` +
 * `message`), while every domain refusal came back as a bare text string - so the client had
 * three decode branches for a contract no test on either side asserted. Now both are json with
 * a `message`, and a domain failure additionally names the `field` it is about.
 */
export const FAILURE_SCHEMA = t.Object({
	message: t.String(),
	field: t.Optional(t.String()),
});

/**
 * Reject a request. Takes the `Failure` the rule produced, or a bare message for the failures
 * that are about the request rather than a field (a missing row, an unauthorized caller).
 */
export const fail = <Code extends 400 | 401 | 403 | 404 | 409>(code: Code, reason: Failure | string) => status(code, typeof reason === 'string' ? { message: reason } : reason);
