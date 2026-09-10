import { relations, sql } from 'drizzle-orm';
import { integer, text, sqliteTable, unique, index } from 'drizzle-orm/sqlite-core';
import { nanoid } from 'nanoid';

export const serverPeersTable = sqliteTable('serverPeers', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => nanoid()),

	createdAt: integer('createdAt', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),

	updatedAt: integer('updatedAt', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),

	friendlyName: text('friendlyName'),

	authToken: text('authToken')
		.notNull()
		.$defaultFn(() => nanoid(32)),

	interfaceName: text('interfaceName').notNull(),
	cidrRange: text('cidrRange').notNull(),
	reservedIps: integer('reservedIps').notNull(),

	wgEndpoint: text('wgEndpoint').notNull(),
	wgListenPort: integer('wgListenPort').notNull(),
	wgAddress: text('wgAddress').notNull(),

	wgPrivateKey: text('wgPrivateKey').notNull(),
	wgPublicKey: text('wgPublicKey').notNull(),

	// gates masquerade for this server's cidrRange. `allowInternet` on a group is
	// inert without this - keeps upgrading an existing deployment from silently
	// turning it into an internet gateway.
	enableNat: integer('enableNat', { mode: 'boolean' }).notNull().default(false),

	// Resolver handed to clients as `DNS =` in their generated config (wg/config.ts). Null
	// omits the line entirely, which is today's behaviour. Lives on the server rather than
	// per-peer because it describes the network the tunnel leads into, not one client.
	dns: text('dns'),

	// Routing table this interface's exit-node traffic is policy-routed into (see
	// wg/exitRouting.ts). Per-interface rather than per-peer so unmarking and re-marking an
	// exit node never churns the table number under live traffic, and allocated explicitly
	// (lowest free in EXIT_ROUTE_TABLE_MIN..MAX, see db/servers.ts's allocateRouteTableId)
	// rather than derived from an ordinal - deleting a server must not renumber the tables
	// of the servers that outlive it. Same `.default(sql`0`)` caveat as statsSince below:
	// drizzle's sqlite dialect prefers a static default over $defaultFn, so every
	// create-server path must pass a real value explicitly.
	routeTableId: integer('routeTableId').notNull().default(sql`0`),

	// Lifetime traffic totals since statsSince, manually resettable (see api/traffic.ts). Kept
	// as running counters rather than derived from trafficBucketsTable because that table is
	// pruned (see wg/traffic.ts) and because a server's total must keep counting traffic from
	// peers that have since been deleted.
	lifetimeRxBytes: integer('lifetimeRxBytes').notNull().default(0),
	lifetimeTxBytes: integer('lifetimeTxBytes').notNull().default(0),
	// SQLite's ALTER TABLE ADD COLUMN refuses a non-constant default (e.g. `unixepoch()`) on a
	// table that already has rows ("Cannot add a column with non-constant default") - the literal
	// `0` default lets the migration add the column, then an UPDATE in the same migration backfills
	// existing rows to the real current time (see drizzle/0003_futuristic_black_knight.sql).
	// drizzle-orm's sqlite dialect always prefers a static `.default()` over `$defaultFn()` when
	// both are set (it never even calls defaultFn), so this `0` would otherwise leak into every
	// new row's insert too - every create-server/create-peer handler must pass statsSince: new
	// Date() explicitly (see api/servers.ts, api/serversPeers.ts) rather than relying on this
	// column default for "now".
	statsSince: integer('statsSince', { mode: 'timestamp' }).notNull().default(sql`0`),
});

export type ServerPeer = typeof serverPeersTable.$inferSelect;

// A tag is a label a server's peers can carry (many-to-many, see peerTagAssignmentsTable).
// Tags replace the old one-group-per-peer model: a peer's effective policy is the ordered
// list of policyGrantsTable rows that reference any of its tags (or the peer itself).
export const peerTagsTable = sqliteTable(
	'peerTags',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => nanoid()),

		createdAt: integer('createdAt', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),

		updatedAt: integer('updatedAt', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),

		serverPeerId: text('serverPeerId')
			.notNull()
			.references(() => serverPeersTable.id, { onDelete: 'cascade' }),

		name: text('name').notNull(),
		friendlyName: text('friendlyName'),
	},
	(t) => [unique().on(t.serverPeerId, t.name)]
);

export type PeerTag = typeof peerTagsTable.$inferSelect;

export const peerTagsRelation = relations(peerTagsTable, ({ one, many }) => ({
	serverPeer: one(serverPeersTable, {
		fields: [peerTagsTable.serverPeerId],
		references: [serverPeersTable.id],
	}),
	assignments: many(peerTagAssignmentsTable),
}));

export const peerTagAssignmentsTable = sqliteTable(
	'peerTagAssignments',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => nanoid()),

		createdAt: integer('createdAt', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),

		peerId: text('peerId')
			.notNull()
			.references(() => peersTable.id, { onDelete: 'cascade' }),

		tagId: text('tagId')
			.notNull()
			.references(() => peerTagsTable.id, { onDelete: 'cascade' }),
	},
	(t) => [unique().on(t.peerId, t.tagId)]
);

export type PeerTagAssignment = typeof peerTagAssignmentsTable.$inferSelect;

export const peerTagAssignmentsRelation = relations(peerTagAssignmentsTable, ({ one }) => ({
	peer: one(peersTable, {
		fields: [peerTagAssignmentsTable.peerId],
		references: [peersTable.id],
	}),
	tag: one(peerTagsTable, {
		fields: [peerTagAssignmentsTable.tagId],
		references: [peerTagsTable.id],
	}),
}));

// A grant is one ordered rule in a server's policy: `action` fires when a packet's source
// matches (srcKind, src*Id) and its destination/protocol/ports match (dstKind, dst*, protocol,
// ports). Grants are evaluated in ascending `position`, first match wins (see wg/firewall.ts) -
// a peer-scoped grant placed above a tag-scoped one is how per-client policy takes precedence.
// Exactly one of the two src*Id columns, and exactly one of the three dst*Id/dstCidr columns
// matching dstKind, is set - enforced at the api layer (sqlite FK enforcement is never turned on
// in this codebase, see groups.ts/policy.ts comments, so this invariant is not a db constraint).
export const policyGrantsTable = sqliteTable('policyGrants', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => nanoid()),

	createdAt: integer('createdAt', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),

	updatedAt: integer('updatedAt', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),

	serverPeerId: text('serverPeerId')
		.notNull()
		.references(() => serverPeersTable.id, { onDelete: 'cascade' }),

	// ascending, per server - determines evaluation order (first match wins)
	position: integer('position').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

	action: text('action', { enum: ['allow', 'deny'] }).notNull(),

	srcKind: text('srcKind', { enum: ['tag', 'peer'] }).notNull(),
	srcTagId: text('srcTagId').references(() => peerTagsTable.id, { onDelete: 'cascade' }),
	srcPeerId: text('srcPeerId').references(() => peersTable.id, { onDelete: 'cascade' }),

	dstKind: text('dstKind', { enum: ['tag', 'peer', 'cidr', 'server', 'internet', 'any'] }).notNull(),
	dstTagId: text('dstTagId').references(() => peerTagsTable.id, { onDelete: 'cascade' }),
	dstPeerId: text('dstPeerId').references(() => peersTable.id, { onDelete: 'cascade' }),
	dstCidr: text('dstCidr'),

	// 'any' matches every protocol/port; ports is only meaningful for tcp/udp
	protocol: text('protocol', { enum: ['any', 'tcp', 'udp', 'icmp'] }).notNull().default('any'),
	// comma-separated ports/ranges, e.g. "22,80,8000-8100" - null/empty means all ports
	ports: text('ports'),

	comment: text('comment'),
});

export type PolicyGrant = typeof policyGrantsTable.$inferSelect;

export const policyGrantsRelation = relations(policyGrantsTable, ({ one }) => ({
	serverPeer: one(serverPeersTable, {
		fields: [policyGrantsTable.serverPeerId],
		references: [serverPeersTable.id],
	}),
	srcTag: one(peerTagsTable, {
		fields: [policyGrantsTable.srcTagId],
		references: [peerTagsTable.id],
		relationName: 'grantSrcTag',
	}),
	srcPeer: one(peersTable, {
		fields: [policyGrantsTable.srcPeerId],
		references: [peersTable.id],
		relationName: 'grantSrcPeer',
	}),
	dstTag: one(peerTagsTable, {
		fields: [policyGrantsTable.dstTagId],
		references: [peerTagsTable.id],
		relationName: 'grantDstTag',
	}),
	dstPeer: one(peersTable, {
		fields: [policyGrantsTable.dstPeerId],
		references: [peersTable.id],
		relationName: 'grantDstPeer',
	}),
}));

export const peersTable = sqliteTable(
	'peers',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => nanoid()),

		createdAt: integer('createdAt', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),

		updatedAt: integer('updatedAt', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),

		friendlyName: text('friendlyName'),

		authToken: text('authToken')
			.notNull()
			.$defaultFn(() => nanoid(32)),

		serverPeerId: text('serverPeerId')
			.notNull()
			.references(() => serverPeersTable.id),

		wgAddress: text('wgAddress').notNull(),

		wgPrivateKey: text('wgPrivateKey').notNull(),
		wgPublicKey: text('wgPublicKey').notNull(),
		wgPresharedKey: text('wgPresharedKey'),

		// no groupId column any more - a peer's tags are the many-to-many peerTagAssignmentsTable.
		// no tags and no grant naming this peer directly = unrestricted (today's behaviour preserved).

		// --- exit nodes (see wg/exitRouting.ts) ------------------------------------------
		// This peer is its server's exit node: internet-bound traffic from peers that point
		// their exitPeerId at it is policy-routed into its tunnel and NAT'd by its own machine.
		// At most one per server - only one peer can own AllowedIPs 0.0.0.0/0 on a wg interface
		// (enforced in api/serversPeers.ts, not by the db).
		isExitNode: integer('isExitNode', { mode: 'boolean' }).notNull().default(false),

		// The exit node this peer reaches the internet through, or null for "no exit node".
		// Must name a peer on the same server carrying isExitNode. This column is both the
		// permission and the routing instruction: no exitPeerId means no `ip rule`, so the
		// peer physically cannot use an exit node even if it hand-edits its own AllowedIPs.
		exitPeerId: text('exitPeerId').references((): any => peersTable.id, { onDelete: 'set null' }),

		// Resolver handed to clients using *this* peer as their exit node, in the ?exit=true
		// config rendering only (wg/config.ts). Only meaningful on an isExitNode row; falls
		// back to the server's `dns` when null. Sending DNS to the local ISP is the main thing
		// an exit node exists to prevent, so it needs to be overridable per exit node.
		exitDns: text('exitDns'),

		// --- advertised subnet routes (see wg/exitRouting.ts) ----------------------------
		// Comma-separated ipv4 CIDR list of LANs reachable *behind* this peer, e.g.
		// "192.168.1.0/24,10.10.0.0/16". Null/empty = advertises nothing, which is every
		// pre-existing row.
		//
		// Deliberately a separate column from isExitNode rather than a generalisation of it:
		// an exit node is *source*-routed (`ip rule from <client>` into a per-interface table)
		// and permissioned by exitPeerId, whereas an advertised route is *destination*-routed
		// (`ip route <cidr> dev <iface>` in the main table, no per-client state at all) and
		// permissioned by the existing `dstKind: 'cidr'` grants. Sharing one column would
		// couple two unrelated code paths for no gain. A peer can be both.
		//
		// Entries are stored network-aligned (see resolveAdvertisedRoutes in wg/addressing.ts):
		// both `ip route` and nft reject a prefix with host bits set, so normalising on write
		// keeps every consumer free to interpolate the stored value verbatim. Overlap with any
		// other peer's routes - on this interface or any other - is rejected at the api layer,
		// not here: cryptokey routing has one owner per prefix on an interface, and the route
		// itself is one entry in the host's main table, so a second claim on an overlapping
		// range would silently steal the first one's traffic.
		advertisedRoutes: text('advertisedRoutes'),

		// Last raw cumulative rx/tx reported by `wg show` (see wg/shell.ts's wgShow), used by
		// wg/traffic.ts to compute a per-tick delta. wgLastSampledAt is null until the first sample -
		// that (not a zero byte count) is how "never sampled" is distinguished from "sampled, 0 bytes".
		wgLastRxBytes: integer('wgLastRxBytes').notNull().default(0),
		wgLastTxBytes: integer('wgLastTxBytes').notNull().default(0),
		wgLastSampledAt: integer('wgLastSampledAt', { mode: 'timestamp' }),

		// Lifetime traffic totals since statsSince, manually resettable (see api/traffic.ts).
		lifetimeRxBytes: integer('lifetimeRxBytes').notNull().default(0),
		lifetimeTxBytes: integer('lifetimeTxBytes').notNull().default(0),
		// SQLite's ALTER TABLE ADD COLUMN refuses a non-constant default (e.g. `unixepoch()`) on a
		// table that already has rows ("Cannot add a column with non-constant default") - the literal
		// `0` default lets the migration add the column, then an UPDATE in the same migration backfills
		// existing rows to the real current time (see drizzle/0003_futuristic_black_knight.sql).
		// drizzle-orm's sqlite dialect always prefers a static `.default()` over `$defaultFn()` when
		// both are set (it never even calls defaultFn), so this `0` would otherwise leak into every
		// new row's insert too - every create-server/create-peer handler must pass statsSince: new
		// Date() explicitly (see api/servers.ts, api/serversPeers.ts) rather than relying on this
		// column default for "now".
		statsSince: integer('statsSince', { mode: 'timestamp' }).notNull().default(sql`0`),
	},
	// one wgAddress per server - resolvePeerAddress (wg/addressing.ts) checks this in-app, but
	// only the DB constraint closes the race between two concurrent peer creates/updates.
	(t) => [unique().on(t.serverPeerId, t.wgAddress)]
);

export const peersRelation = relations(peersTable, ({ one, many }) => ({
	serverPeer: one(serverPeersTable, {
		fields: [peersTable.serverPeerId],
		references: [serverPeersTable.id],
	}),
	exitPeer: one(peersTable, {
		fields: [peersTable.exitPeerId],
		references: [peersTable.id],
		relationName: 'peerExitPeer',
	}),
	tagAssignments: many(peerTagAssignmentsTable),
}));

export type Peer = typeof peersTable.$inferSelect;

// RRD-style rollup storage for the traffic-graph feature (see wg/traffic.ts). One row = one
// (peer, resolution, aligned bucket) accumulator. There is deliberately no separate server-level
// bucket table - server-aggregate time series are a SUM(...) GROUP BY bucketStart query over
// these rows at read time (see api/traffic.ts), avoiding a second write/consolidation path that
// could drift from the peer-level one.
export const trafficBucketsTable = sqliteTable(
	'trafficBuckets',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => nanoid()),

		peerId: text('peerId')
			.notNull()
			.references(() => peersTable.id, { onDelete: 'cascade' }),

		// denormalized from peersTable.serverPeerId - a peer never moves between servers in this
		// codebase, so this is stable and lets server-aggregate queries group by serverPeerId
		// directly without joining peersTable on every read.
		serverPeerId: text('serverPeerId')
			.notNull()
			.references(() => serverPeersTable.id, { onDelete: 'cascade' }),

		resolution: text('resolution', { enum: ['1m', '1h', '1d'] }).notNull(),

		// start of the aligned bucket (unix seconds, UTC-aligned to the resolution boundary - see
		// wg/traffic.ts's bucketStartFor)
		bucketStart: integer('bucketStart', { mode: 'timestamp' }).notNull(),

		rxBytes: integer('rxBytes').notNull().default(0),
		txBytes: integer('txBytes').notNull().default(0),
	},
	(t) => [unique().on(t.peerId, t.resolution, t.bucketStart), index('trafficBuckets_server_res_bucket_idx').on(t.serverPeerId, t.resolution, t.bucketStart)]
);

export type TrafficBucket = typeof trafficBucketsTable.$inferSelect;

// Expiring admin login sessions issued by the login flow.
export const adminSessionsTable = sqliteTable(
	'adminSessions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => nanoid()),

		token: text('token').notNull().unique(),

		createdAt: integer('createdAt', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),

		expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
	},
	(t) => [index('adminSessions_token_idx').on(t.token), index('adminSessions_expiresAt_idx').on(t.expiresAt)]
);

export type AdminSession = typeof adminSessionsTable.$inferSelect;
