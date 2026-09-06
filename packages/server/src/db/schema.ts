import { relations } from 'drizzle-orm';
import { integer, text, sqliteTable, unique } from 'drizzle-orm/sqlite-core';
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

export const peersTable = sqliteTable('peers', {
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
});

export const peersRelation = relations(peersTable, ({ one, many }) => ({
	serverPeer: one(serverPeersTable, {
		fields: [peersTable.serverPeerId],
		references: [serverPeersTable.id],
	}),
	tagAssignments: many(peerTagAssignmentsTable),
}));

export type Peer = typeof peersTable.$inferSelect;
