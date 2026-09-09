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
