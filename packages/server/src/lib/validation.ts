// Shared between the server's TypeBox schemas and the app's client-side form validation
// (ServerModal.vue, PeerModal.vue) - the app imports server code directly (see CLAUDE.md), so
// these are the single source of truth for both instead of two hand-mirrored copies.

export const INTERFACE_NAME_REGEX = /^[a-zA-Z0-9_=+.-]{1,15}$/;
export const CIDR_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[1-2][0-9]|3[0-2])$/;

// wgAddress (server gateway or peer address) may carry an optional /prefix - see wg/config.ts,
// which appends a default one (/24 for a server, /32 for a peer) only when the stored value
// doesn't already include one.
export const IPV4_ADDRESS_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?:\/(?:[0-9]|[1-2][0-9]|3[0-2]))?$/;

export const WG_LISTEN_PORT_MIN = 1;
export const WG_LISTEN_PORT_MAX = 65535;

/**
 * Splits the comma-separated CIDR list stored in `peers.advertisedRoutes` (and typed into the
 * peer form) into its entries. Tolerant of whitespace, newlines and trailing commas, because
 * a human types this field and pasting a list with spaces after the commas must not turn into
 * a validation error. Deliberately does *not* validate - CIDR_REGEX above and
 * resolveAdvertisedRoutes (wg/addressing.ts, which also network-aligns each entry) do that;
 * this only has to agree about what the separators are.
 */
export const parseCidrList = (value: string | null | undefined): string[] =>
	(value ?? '')
		.split(/[\s,]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
