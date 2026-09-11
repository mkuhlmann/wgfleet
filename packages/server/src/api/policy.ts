import { Elysia, status, t } from 'elysia';
import { db } from '../db';
import { peerTagAssignmentsTable, peerTagsTable, peersTable, policyGrantsTable } from '../db/schema';
import { eq, and, ne, inArray, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { isIpv4Cidr } from '../wg/firewall';
import { converge } from '../wg/converge';
import { memberCountByTag, policyGraphOf, toPolicyDocument } from '@server/db/policyGraph';
import { auth } from './auth';
import { createLog } from '@server/lib/log';

const log = createLog('http');

const nameRegex = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// comma-separated ports/ranges, e.g. "22,80,8000-8100" - each endpoint 1-65535, lo <= hi
const portsRegex = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/;
const maxPortEntries = 32;

async function isTagNameInUse(serverPeerId: string, name: string, excludeTagId?: string) {
	const existing = await db.query.peerTagsTable.findFirst({
		where: excludeTagId ? and(eq(peerTagsTable.serverPeerId, serverPeerId), eq(peerTagsTable.name, name), ne(peerTagsTable.id, excludeTagId)) : and(eq(peerTagsTable.serverPeerId, serverPeerId), eq(peerTagsTable.name, name)),
	});
	return !!existing;
}

function isValidPorts(ports: string): boolean {
	if (!portsRegex.test(ports)) return false;
	const entries = ports.split(',');
	if (entries.length > maxPortEntries) return false;
	for (const entry of entries) {
		const [loStr, hiStr] = entry.split('-');
		const lo = Number(loStr);
		const hi = hiStr !== undefined ? Number(hiStr) : lo;
		if (lo < 1 || lo > 65535 || hi < 1 || hi > 65535 || lo > hi) return false;
	}
	return true;
}

// ports is only meaningful for tcp/udp - returns an error message, or null if ok
function validatePorts(protocol: string | undefined, ports: string | null | undefined): string | null {
	if (!ports || !ports.trim()) return null;
	if (protocol !== 'tcp' && protocol !== 'udp') return 'ports can only be set when protocol is tcp or udp';
	if (!isValidPorts(ports)) return `Invalid ports: ${ports}`;
	return null;
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
	dstKind: t.Union([t.Literal('tag'), t.Literal('peer'), t.Literal('cidr'), t.Literal('server'), t.Literal('internet'), t.Literal('any')]),
	dstTagId: t.Optional(t.String()),
	dstPeerId: t.Optional(t.String()),
	dstCidr: t.Optional(t.String()),
	protocol: t.Optional(t.Union([t.Literal('any'), t.Literal('tcp'), t.Literal('udp'), t.Literal('icmp')])),
	ports: t.Optional(t.Nullable(t.String())),
	comment: t.Optional(t.Nullable(t.String())),
});

// validates an id-based grant against this server's tags/peers - null means valid
async function validateGrant(serverPeerId: string, g: typeof grantBody.static): Promise<string | null> {
	if (g.srcKind === 'tag') {
		if (!g.srcTagId) return 'srcTagId is required when srcKind is "tag"';
		const tag = await db.query.peerTagsTable.findFirst({ where: and(eq(peerTagsTable.id, g.srcTagId), eq(peerTagsTable.serverPeerId, serverPeerId)) });
		if (!tag) return `Source tag ${g.srcTagId} not found on this server`;
	} else if (!g.srcPeerId) {
		return 'srcPeerId is required when srcKind is "peer"';
	} else {
		const peer = await db.query.peersTable.findFirst({ where: and(eq(peersTable.id, g.srcPeerId), eq(peersTable.serverPeerId, serverPeerId)) });
		if (!peer) return `Source peer ${g.srcPeerId} not found on this server`;
	}

	switch (g.dstKind) {
		case 'tag': {
			if (!g.dstTagId) return 'dstTagId is required when dstKind is "tag"';
			const tag = await db.query.peerTagsTable.findFirst({ where: and(eq(peerTagsTable.id, g.dstTagId), eq(peerTagsTable.serverPeerId, serverPeerId)) });
			if (!tag) return `Destination tag ${g.dstTagId} not found on this server`;
			break;
		}
		case 'peer': {
			if (!g.dstPeerId) return 'dstPeerId is required when dstKind is "peer"';
			const peer = await db.query.peersTable.findFirst({ where: and(eq(peersTable.id, g.dstPeerId), eq(peersTable.serverPeerId, serverPeerId)) });
			if (!peer) return `Destination peer ${g.dstPeerId} not found on this server`;
			break;
		}
		case 'cidr':
			// ipv4-only - the firewall this feeds (wg/firewall.ts) is ipv4-only throughout
			if (!g.dstCidr || !isIpv4Cidr(g.dstCidr)) return `Invalid or non-ipv4 CIDR: ${g.dstCidr}`;
			break;
		case 'server':
		case 'internet':
		case 'any':
			break;
	}

	return validatePorts(g.protocol, g.ports);
}

// The JSON policy document format - grants reference tags by name (see grantBody comment above).
const policyGrantDoc = t.Object({
	enabled: t.Optional(t.Boolean({ default: true })),
	action: t.Union([t.Literal('allow'), t.Literal('deny')]),
	srcKind: t.Union([t.Literal('tag'), t.Literal('peer')]),
	srcTag: t.Optional(t.String()),
	srcPeerId: t.Optional(t.String()),
	dstKind: t.Union([t.Literal('tag'), t.Literal('peer'), t.Literal('cidr'), t.Literal('server'), t.Literal('internet'), t.Literal('any')]),
	dstTag: t.Optional(t.String()),
	dstPeerId: t.Optional(t.String()),
	dstCidr: t.Optional(t.String()),
	protocol: t.Optional(t.Union([t.Literal('any'), t.Literal('tcp'), t.Literal('udp'), t.Literal('icmp')])),
	ports: t.Optional(t.Nullable(t.String())),
	comment: t.Optional(t.Nullable(t.String())),
});

const policyDocBody = t.Object({
	tags: t.Array(t.Object({ name: t.RegExp(nameRegex), friendlyName: t.Optional(t.String()) })),
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
		{ params: t.Object({ id: t.String() }), serverScope: true }
	)
	.post(
		'/wg/servers/:id/tags',
		async ({ wgServer: server, params, body }) => {
			if (await isTagNameInUse(server.id, body.name)) {
				return status(400, 'A tag with this name already exists on this server');
			}

			const tag = await db.insert(peerTagsTable).values({ serverPeerId: server.id, name: body.name, friendlyName: body.friendlyName }).returning();

			log.info(`Created tag ${tag[0].id} on server ${server.id}`);
			await converge(server.id);

			return tag[0];
		},
		{
			body: t.Object({ name: t.RegExp(nameRegex), friendlyName: t.Optional(t.String()) }),
			params: t.Object({ id: t.String() }),
			serverScope: true,
		}
	)
	.patch(
		'/wg/servers/:id/tags/:tagId',
		async ({ wgServer: server, params, body }) => {
			const tag = await db.query.peerTagsTable.findFirst({
				where: and(eq(peerTagsTable.id, params.tagId), eq(peerTagsTable.serverPeerId, server.id)),
			});
			if (!tag) return status(404, 'Tag not found');

			if (body.name && (await isTagNameInUse(server.id, body.name, tag.id))) {
				return status(400, 'A tag with this name already exists on this server');
			}

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
			body: t.Object({ name: t.Optional(t.RegExp(nameRegex)), friendlyName: t.Optional(t.String()) }),
			params: t.Object({ id: t.String(), tagId: t.String() }),
			serverScope: true,
		}
	)
	.delete(
		'/wg/servers/:id/tags/:tagId',
		async ({ wgServer: server, params }) => {
			const tag = await db.query.peerTagsTable.findFirst({
				where: and(eq(peerTagsTable.id, params.tagId), eq(peerTagsTable.serverPeerId, server.id)),
			});
			if (!tag) return status(404, 'Tag not found');

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
		{ params: t.Object({ id: t.String(), tagId: t.String() }), serverScope: true }
	)
	// --- grants (ordered, replace-all) ------------------------------------
	.get(
		'/wg/servers/:id/grants',
		async ({ wgServer: server, params }) => {
			return db.query.policyGrantsTable.findMany({ where: eq(policyGrantsTable.serverPeerId, server.id), orderBy: asc(policyGrantsTable.position) });
		},
		{ params: t.Object({ id: t.String() }), serverScope: true }
	)
	.put(
		'/wg/servers/:id/grants',
		async ({ wgServer: server, params, body }) => {
			for (const g of body.grants) {
				const error = await validateGrant(server.id, g);
				if (error) return status(400, error);
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
		}
	)
	// --- whole-document policy (json import/export) ------------------------
	.get(
		'/wg/servers/:id/policy',
		async ({ wgServer: server, params }) => {
			return toPolicyDocument(await policyGraphOf(server));
		},
		{ params: t.Object({ id: t.String() }), serverScope: true }
	)
	.put(
		'/wg/servers/:id/policy',
		async ({ wgServer: server, params, body }) => {
			const tagNames = new Set<string>();
			for (const tag of body.tags) {
				if (tagNames.has(tag.name)) return status(400, `Duplicate tag name in document: ${tag.name}`);
				tagNames.add(tag.name);
			}

			const peers = await db.query.peersTable.findMany({ where: eq(peersTable.serverPeerId, server.id) });
			const peerIds = new Set(peers.map((p) => p.id));

			for (const pt of body.peerTags) {
				if (!peerIds.has(pt.peerId)) return status(400, `Peer ${pt.peerId} not found on this server`);
				for (const tagName of pt.tags) {
					if (!tagNames.has(tagName)) return status(400, `Unknown tag "${tagName}" referenced for peer ${pt.peerId}`);
				}
			}

			for (const g of body.grants) {
				if (g.srcKind === 'tag') {
					if (!g.srcTag || !tagNames.has(g.srcTag)) return status(400, `Unknown source tag "${g.srcTag}"`);
				} else if (!g.srcPeerId || !peerIds.has(g.srcPeerId)) {
					return status(400, `Unknown source peer "${g.srcPeerId}"`);
				}

				switch (g.dstKind) {
					case 'tag':
						if (!g.dstTag || !tagNames.has(g.dstTag)) return status(400, `Unknown destination tag "${g.dstTag}"`);
						break;
					case 'peer':
						if (!g.dstPeerId || !peerIds.has(g.dstPeerId)) return status(400, `Unknown destination peer "${g.dstPeerId}"`);
						break;
					case 'cidr':
						if (!g.dstCidr || !isIpv4Cidr(g.dstCidr)) return status(400, `Invalid or non-ipv4 CIDR: ${g.dstCidr}`);
						break;
					case 'server':
					case 'internet':
					case 'any':
						break;
				}

				const portsError = validatePorts(g.protocol, g.ports);
				if (portsError) return status(400, portsError);
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
		{ body: policyDocBody, params: t.Object({ id: t.String() }), serverScope: true }
	);
