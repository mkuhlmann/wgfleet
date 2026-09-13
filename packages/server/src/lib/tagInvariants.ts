import { failure, type Failure } from './failure';
import { TAG_NAME_REGEX } from './validation';

/**
 * The rules a tag write has to satisfy. Small, but it is the third copy of the name regex that
 * this replaces: the api spelled it inline and TagModal.vue spelled it again, byte-identically
 * and with no import between them.
 */
export type InvariantTag = { id: string; name: string };

export type TagInvariantSnapshot = {
	/** every tag on this server, including the one being edited */
	tags: InvariantTag[];
};

export type TagInvariantRequest = { name?: string };

export function checkTagInvariants(snapshot: TagInvariantSnapshot, current: InvariantTag | null, request: TagInvariantRequest): Failure | null {
	if (request.name === undefined) return null;

	if (!TAG_NAME_REGEX.test(request.name)) {
		return failure('lowercase letters, numbers and hyphens only, must start/end with a letter or number.', 'name');
	}

	if (snapshot.tags.some((t) => t.id !== current?.id && t.name === request.name)) {
		return failure('A tag with this name already exists on this server', 'name');
	}

	return null;
}
