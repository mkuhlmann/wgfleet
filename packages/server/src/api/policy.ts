import { Elysia, t } from 'elysia';
import { fail } from './failure';
import { failure } from '@server/lib/failure';
import { db } from '../db';
import { peerTagAssignmentsTable, peerTagsTable, peersTable, policyGrantsTable } from '../db/schema';
import { eq, and, inArray, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { checkGrantInvariants, type GrantInvariantSnapshot, type GrantRef } from '@server/lib/grantInvariants';
import { checkTagInvariants } from '@server/lib/tagInvariants';
import { TAG_NAME_REGEX } from '@server/lib/validation';
import { converge } from '../wg/converge';
import { memberCountByTag, policyGraphOf, toPolicyDocument } from '@server/db/policyGraph';
import { auth } from './auth';
import { createLog } from '@server/lib/log';

const log = createLog('http');

/** Every tag on this server, as lib/tagInvariants.ts wants it. */
async function loadTagSnapshot(serverPeerId: string) {
	return { tags: await db.select({ id: peerTagsTable.id, name: peerTagsTable.name }).from(peerTagsTable).where(eq(peerTagsTable.serverPeerId, serverPeerId)) };
}

// id-based grant shape - used by the structured editor (PUT .../grants), which already has
// live tag/peer dropdowns backed by real ids. The JSON policy document (GET/PUT .../policy)
// uses tag *names* instead - see policyGrantDoc below - since ids are meaningless to a human
// hand-editing the document and new tags in an imported document don't have ids yet.
const grantBody = t.Object({
	enabled: t.Optional(t.Boolean({ default: true })),
	action: t.Union([t.Literal('allow'), t.Literal('deny')]),
	srcKind: t.Union([t.Literal('tag'), t.Literal('peer')]),
	srcTagId: t.Optional(t.String()),
	srcPeerId: t.Optional(t.String()),
	dstKind: t.Union([t.Literal('tag'), t.Literal('peer'), t.Literal('cidr'), t.Literal('server'), t.Literal('any')]),
	dstTagId: t.Optional(t.String()),
	dstPeerId: t.Optional(t.String()),
	dstCidr: t.Optional(t.String()),
	protocol: t.Optional(t.Union([t.Literal('any'), t.Literal('tcp'), t.Literal('udp'), t.Literal('icmp')])),
	ports: t.Optional(t.Nullable(t.String())),
	comment: t.Optional(t.Nullable(t.String())),
});

/**
 * One grant's references, as lib/grantInvariants.ts wants them. The two write paths spell a
 * grant differently - this one by id, the JSON policy document by tag *name* - so they resolve
 * to this shape first and then run the identical rules, instead of validating the same five
 * dstKind cases twice.
 */
const grantRefs = (g: {
	srcKind: 'tag' | 'peer';
	srcTagId?: string | null;
	srcPeerId?: string | null;
	dstKind: 'tag' | 'peer' | 'cidr' | 'server' | 'any';
	dstTagId?: string | null;
	dstPeerId?: string | null;
	dstCidr?: string | null;
}): { src: GrantRef; dst: GrantRef } => ({
	src: g.srcKind === 'tag' ? { kind: 'tag', id: g.srcTagId } : { kind: 'peer', id: g.srcPeerId },
	dst: g.dstKind === 'tag' ? { kind: 'tag', id: g.dstTagId } : g.dstKind === 'peer' ? { kind: 'peer', id: g.dstPeerId } : g.dstKind === 'cidr' ? { kind: 'cidr', cidr: g.dstCidr } : { kind: g.dstKind },
});

/** Tag and peer ids on this server - what the grant rules resolve references against. */
async function loadGrantSnapshot(serverPeerId: string): Promise<GrantInvariantSnapshot> {
	const [tags, peers] = await Promise.all([
		db.select({ id: peerTagsTable.id }).from(peerTagsTable).where(eq(peerTagsTable.serverPeerId, serverPeerId)),
		db.select({ id: peersTable.id }).from(peersTable).where(eq(peersTable.serverPeerId, serverPeerId)),
	]);

	return { tagIds: tags.map((t) => t.id), peerIds: peers.map((p) => p.id) };
}

// The JSON policy document format - grants reference tags by name (see grantBody comment above).
const policyGrantDoc = t.Object({
	enabled: t.Optional(t.Boolean({ default: true })),
	action: t.Union([t.Literal('allow'), t.Literal('deny')]),
	srcKind: t.Union([t.Literal('tag'), t.Literal('peer')]),
	srcTag: t.Optional(t.String()),
	srcPeerId: t.Optional(t.String()),
	dstKind: t.Union([t.Literal('tag'), t.Literal('peer'), t.Literal('cidr'), t.Literal('server'), t.Literal('any')]),
	dstTag: t.Optional(t.String()),
	dstPeerId: t.Optional(t.String()),
	dstCidr: t.Optional(t.String()),
	protocol: t.Optional(t.Union([t.Literal('any'), t.Literal('tcp'), t.Literal('udp'), t.Literal('icmp')])),
	ports: t.Optional(t.Nullable(t.String())),
	comment: t.Optional(t.Nullable(t.String())),
});

const policyDocBody = t.Object({
	tags: t.Array(t.Object({ name: t.RegExp(TAG_NAME_REGEX), friendlyName: t.Optional(t.String()) })),
	grants: t.Array(policyGrantDoc),
	peerTags: t.Array(t.Object({ peerId: t.String(), friendlyName: t.Optional(t.String()), tags: t.Array(t.String()) })),
});

export const policyRoutes = new Elysia()
	.use(auth)
	// --- tags -------------------------------------------------------------
	.get(
		'/wg/servers/:id/tags',
		async ({ wgServer: server, params }) => {
			const graph = await policyGraphOf(server);

			const counts = memberCountByTag(graph);
			return graph.tags.map((tag) => ({ ...tag, memberCount: counts.get(tag.id) ?? 0 }));
		},
		{ params: t.Object({ id: t.String() }), serverScope: true },
	)
	.post(
		'/wg/servers/:id/tags',
		async ({ wgServer: server, params, body }) => {
			// the same function TagModal.vue validates with (lib/tagInvariants.ts) - name format
			// and uniqueness stated once rather than re-spelled on each side
			const invalid = checkTagInvariants(await loadTagSnapshot(server.id), null, body);
			if (invalid) return fail(400, invalid);

			const tag = await db.insert(peerTagsTable).values({ serverPeerId: server.id, name: body.name, friendlyName: body.friendlyName }).returning();

			log.info(`Created tag ${tag[0].id} on server ${server.id}`);
			await converge(server.id);

			return tag[0];
		},
		{
			body: t.Object({ name: t.RegExp(TAG_NAME_REGEX), friendlyName: t.Optional(t.String()) }),
			params: t.Object({ id: t.String() }),
			serverScope: true,
		},
	)
	.patch(
		'/wg/servers/:id/tags/:tagId',
		async ({ wgServer: server, params, body }) => {
			const tag = await db.query.peerTagsTable.findFirst({
				where: and(eq(peerTagsTable.id, params.tagId), eq(peerTagsTable.serverPeerId, server.id)),
			});
			if (!tag) return fail(404, 'Tag not found');

			const invalid = checkTagInvariants(await loadTagSnapshot(server.id), tag, body);
			if (invalid) return fail(400, invalid);

			const updated = await db
				.update(peerTagsTable)
				.set({ name: body.name ?? tag.name, friendlyName: body.friendlyName ?? tag.friendlyName, updatedAt: new Date() })
				.where(eq(peerTagsTable.id, tag.id))
				.returning();

			log.info(`Updated tag ${tag.id} on server ${server.id}`);
			await converge(server.id);

			return updated[0];
		},
		{
			body: t.Object({ name: t.Optional(t.RegExp(TAG_NAME_REGEX)), friendlyName: t.Optional(t.String()) }),
			params: t.Object({ id: t.String(), tagId: t.String() }),
			serverScope: true,
		},
	)
	.delete(
		'/wg/servers/:id/tags/:tagId',
		async ({ wgServer: server, params }) => {
			const tag = await db.query.peerTagsTable.findFirst({
				where: and(eq(peerTagsTable.id, params.tagId), eq(peerTagsTable.serverPeerId, server.id)),
			});
			if (!tag) return fail(404, 'Tag not found');

			// no db-level FK enforcement (sqlite foreign_keys pragma isn't turned on
			// anywhere in this codebase), so cascade cleanup happens explicitly here.
			db.transaction((tx) => {
				tx.delete(peerTagAssignmentsTable).where(eq(peerTagAssignmentsTable.tagId, tag.id)).run();
				tx.delete(policyGrantsTable).where(eq(policyGrantsTable.srcTagId, tag.id)).run();
				tx.delete(policyGrantsTable).where(eq(policyGrantsTable.dstTagId, tag.id)).run();
				tx.delete(peerTagsTable).where(eq(peerTagsTable.id, tag.id)).run();
			});

			log.info(`Deleted tag ${tag.id} from server ${server.id}`);
			await converge(server.id);

			return { success: true };
		},
		{ params: t.Object({ id: t.String(), tagId: t.String() }), serverScope: true },
	)
	// --- grants (ordered, replace-all) ------------------------------------
	.get(
		'/wg/servers/:id/grants',
		async ({ wgServer: server, params }) => {
			return db.query.policyGrantsTable.findMany({ where: eq(policyGrantsTable.serverPeerId, server.id), orderBy: asc(policyGrantsTable.position) });
		},
		{ params: t.Object({ id: t.String() }), serverScope: true },
	)
	.put(
		'/wg/servers/:id/grants',
		async ({ wgServer: server, params, body }) => {
			const snapshot = await loadGrantSnapshot(server.id);
			for (const g of body.grants) {
				const invalid = checkGrantInvariants(snapshot, { ...grantRefs(g), protocol: g.protocol, ports: g.ports });
				if (invalid) return fail(400, invalid);
			}

			db.transaction((tx) => {
				tx.delete(policyGrantsTable).where(eq(policyGrantsTable.serverPeerId, server.id)).run();

				body.grants.forEach((g, position) => {
					tx.insert(policyGrantsTable)
						.values({
							serverPeerId: server.id,
							position,
							enabled: g.enabled ?? true,
							action: g.action,
							srcKind: g.srcKind,
							srcTagId: g.srcKind === 'tag' ? (g.srcTagId ?? null) : null,
							srcPeerId: g.srcKind === 'peer' ? (g.srcPeerId ?? null) : null,
							dstKind: g.dstKind,
							dstTagId: g.dstKind === 'tag' ? (g.dstTagId ?? null) : null,
							dstPeerId: g.dstKind === 'peer' ? (g.dstPeerId ?? null) : null,
							dstCidr: g.dstKind === 'cidr' ? (g.dstCidr ?? null) : null,
							protocol: g.protocol ?? 'any',
							ports: g.ports ?? null,
							comment: g.comment ?? null,
						})
						.run();
				});
			});

			log.info(`Replaced grants for server ${server.id}`);
			await converge(server.id);

			return db.query.policyGrantsTable.findMany({ where: eq(policyGrantsTable.serverPeerId, server.id), orderBy: asc(policyGrantsTable.position) });
		},
		{
			body: t.Object({ grants: t.Array(grantBody) }),
			params: t.Object({ id: t.String() }),
			serverScope: true,
		},
	)
	// --- whole-document policy (json import/export) ------------------------
	.get(
		'/wg/servers/:id/policy',
		async ({ wgServer: server, params }) => {
			return toPolicyDocument(await policyGraphOf(server));
		},
		{ params: t.Object({ id: t.String() }), serverScope: true },
	)
	.put(
		'/wg/servers/:id/policy',
		async ({ wgServer: server, params, body }) => {
			const tagNames = new Set<string>();
			for (const tag of body.tags) {
				if (tagNames.has(tag.name)) return fail(400, `Duplicate tag name in document: ${tag.name}`);
				tagNames.add(tag.name);
			}

			const peers = await db.query.peersTable.findMany({ where: eq(peersTable.serverPeerId, server.id) });
			const peerIds = new Set(peers.map((p) => p.id));

			for (const pt of body.peerTags) {
				if (!peerIds.has(pt.peerId)) return fail(400, `Peer ${pt.peerId} not found on this server`);
				for (const tagName of pt.tags) {
					if (!tagNames.has(tagName)) return fail(400, `Unknown tag "${tagName}" referenced for peer ${pt.peerId}`);
				}
			}

			// The document addresses tags by name rather than id (new tags in an imported document
			// have no id yet), so names *are* the identifiers here - same rules, same module.
			const documentSnapshot = { tagIds: [...tagNames], peerIds: [...peerIds] };
			for (const g of body.grants) {
				const invalid = checkGrantInvariants(documentSnapshot, {
					...grantRefs({ ...g, srcTagId: g.srcTag, dstTagId: g.dstTag }),
					protocol: g.protocol,
					ports: g.ports,
				});
				if (invalid) return fail(400, invalid);
			}

			// all validated (reads only, done above) - apply the whole document atomically.
			// db.transaction() is synchronous (bun:sqlite), so no further awaits below.
			db.transaction((tx) => {
				tx.delete(policyGrantsTable).where(eq(policyGrantsTable.serverPeerId, server.id)).run();
				if (peerIds.size) {
					tx.delete(peerTagAssignmentsTable)
						.where(inArray(peerTagAssignmentsTable.peerId, [...peerIds]))
						.run();
				}
				tx.delete(peerTagsTable).where(eq(peerTagsTable.serverPeerId, server.id)).run();

				const tagIdByName = new Map<string, string>();
				for (const tag of body.tags) {
					const id = nanoid();
					tagIdByName.set(tag.name, id);
					tx.insert(peerTagsTable).values({ id, serverPeerId: server.id, name: tag.name, friendlyName: tag.friendlyName }).run();
				}

				for (const pt of body.peerTags) {
					for (const tagName of pt.tags) {
						const tagId = tagIdByName.get(tagName);
						if (!tagId) continue;
						tx.insert(peerTagAssignmentsTable).values({ peerId: pt.peerId, tagId }).run();
					}
				}

				body.grants.forEach((g, position) => {
					tx.insert(policyGrantsTable)
						.values({
							serverPeerId: server.id,
							position,
							enabled: g.enabled ?? true,
							action: g.action,
							srcKind: g.srcKind,
							srcTagId: g.srcKind === 'tag' ? (tagIdByName.get(g.srcTag!) ?? null) : null,
							srcPeerId: g.srcKind === 'peer' ? (g.srcPeerId ?? null) : null,
							dstKind: g.dstKind,
							dstTagId: g.dstKind === 'tag' ? (tagIdByName.get(g.dstTag!) ?? null) : null,
							dstPeerId: g.dstKind === 'peer' ? (g.dstPeerId ?? null) : null,
							dstCidr: g.dstKind === 'cidr' ? (g.dstCidr ?? null) : null,
							protocol: g.protocol ?? 'any',
							ports: g.ports ?? null,
							comment: g.comment ?? null,
						})
						.run();
				});
			});

			log.info(`Replaced policy document on server ${server.id}`);
			await converge(server.id);

			return toPolicyDocument(await policyGraphOf(server));
		},
		{ body: policyDocBody, params: t.Object({ id: t.String() }), serverScope: true },
	);
