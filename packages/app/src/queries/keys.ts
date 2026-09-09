import type { QueryClient } from '@tanstack/vue-query';

// Query key factory for this app's server-state cache. Every queryOptions() in this
// directory builds its queryKey from here instead of a literal array, and every mutation's
// onSuccess invalidates through `invalidate` below instead of re-typing the key by hand -
// see CLAUDE.md's note that mutations stay inline in the modal component that owns them;
// only the *keys* they invalidate are centralized here, so "what goes stale when X changes"
// is decided once instead of at each of the ~7 mutation sites that used to answer it
// independently (several of them incompletely).
export const queryKeys = {
	serverList: () => ['servers'] as const,
	// bare prefix, no id - matches every ['server', id] entry for invalidation. queryServer()
	// below appends the id itself.
	serverBase: () => ['server'] as const,
	server: (id: string) => [...queryKeys.serverBase(), id] as const,

	serverPeers: (id: string) => ['serverPeers', id] as const,
	serverTags: (id: string) => ['serverTags', id] as const,
	serverGrants: (id: string) => ['serverGrants', id] as const,
	serverPolicy: (id: string) => ['serverPolicy', id] as const,

	serverTraffic: (id: string, resolution: string) => ['serverTraffic', id, resolution] as const,

	// prefix (no resolution) - matches every cached resolution for one peer, so a reset can
	// invalidate all of them without knowing which resolution is currently selected
	peerTrafficForPeer: (id: string, peerId: string) => ['peerTraffic', id, peerId] as const,
	peerTraffic: (id: string, peerId: string, resolution: string) => [...queryKeys.peerTrafficForPeer(id, peerId), resolution] as const,
};

const inv = (qc: QueryClient, queryKey: readonly unknown[]) => qc.invalidateQueries({ queryKey: queryKey as unknown[] });

/**
 * One function per mutated entity, naming the full fan-out of what a change to it makes
 * stale. Each maps directly to a cascade on the server side (see api/policy.ts and
 * api/serversPeers.ts's cascade-delete comments) - a tag delete unassigns member peers and
 * removes referencing grants, so it invalidates peers and grants too, not just tags.
 */
export const invalidate = {
	afterServerChange: (qc: QueryClient) => Promise.all([inv(qc, queryKeys.serverList()), inv(qc, queryKeys.serverBase())]),

	afterPeerChange: (qc: QueryClient, serverId: string) =>
		Promise.all([inv(qc, queryKeys.serverPeers(serverId)), inv(qc, queryKeys.serverTags(serverId)), inv(qc, queryKeys.serverPolicy(serverId))]),

	afterPeerDelete: (qc: QueryClient, serverId: string) =>
		Promise.all([
			inv(qc, queryKeys.serverPeers(serverId)),
			inv(qc, queryKeys.serverTags(serverId)),
			inv(qc, queryKeys.serverGrants(serverId)),
			inv(qc, queryKeys.serverPolicy(serverId)),
		]),

	afterTagChange: (qc: QueryClient, serverId: string) => Promise.all([inv(qc, queryKeys.serverTags(serverId)), inv(qc, queryKeys.serverPolicy(serverId))]),

	afterTagDelete: (qc: QueryClient, serverId: string) =>
		Promise.all([
			inv(qc, queryKeys.serverTags(serverId)),
			inv(qc, queryKeys.serverGrants(serverId)),
			inv(qc, queryKeys.serverPeers(serverId)),
			inv(qc, queryKeys.serverPolicy(serverId)),
		]),

	afterGrantsChange: (qc: QueryClient, serverId: string) => Promise.all([inv(qc, queryKeys.serverGrants(serverId)), inv(qc, queryKeys.serverPolicy(serverId))]),

	afterPolicyApply: (qc: QueryClient, serverId: string) =>
		Promise.all([
			inv(qc, queryKeys.serverPolicy(serverId)),
			inv(qc, queryKeys.serverTags(serverId)),
			inv(qc, queryKeys.serverGrants(serverId)),
			inv(qc, queryKeys.serverPeers(serverId)),
		]),

	afterPeerTrafficReset: (qc: QueryClient, serverId: string, peerId: string) =>
		Promise.all([inv(qc, queryKeys.serverPeers(serverId)), inv(qc, queryKeys.peerTrafficForPeer(serverId, peerId))]),
};
