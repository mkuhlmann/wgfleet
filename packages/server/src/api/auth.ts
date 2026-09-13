import { Elysia, t } from 'elysia';
import { fail } from './failure';
import { db } from '@server/db';
import { adminSessionsTable, peersTable } from '@server/db/schema';
import { and, eq, gt, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { resolveServer } from '@server/db/servers';

// The bearer token on a request, or null. A token either equals ADMIN_TOKEN (god-mode) or is a
// live admin session; anything else is only meaningful against a specific row's authToken.
const bearerToken = (authorization: string | undefined): string | null => authorization?.split(' ')[1]?.trim() || null;

const isAdmin = async (token: string): Promise<boolean> => {
	if (token === process.env.ADMIN_TOKEN?.trim()) return true;

	const session = await db.query.adminSessionsTable.findFirst({
		where: and(eq(adminSessionsTable.token, token), gt(adminSessionsTable.expiresAt, new Date())),
	});

	return !!session;
};

// The three *Scope macros below are written in elysia's object form (`name: { resolve }`) and
// not its function form (`name(config) { return { resolve } }`) on purpose: only the object
// form propagates a resolve's return type into the handler's context. In function form the
// values still arrive at runtime, but every route using the macro silently loses the inferred
// type of its own `body`/`params` too - which, because `App` is `typeof _app`, degrades the
// frontend's Eden types as well. Both forms have to live in one `.macro({...})` call for the
// same reason: chaining a second `.macro()` also drops the inference.
export const auth = new Elysia({ name: 'auth' }).macro({
	verifyAuth(
		config: {
			scope?: 'admin' | 'server' | 'peer';
		} = {
			scope: 'admin',
		},
	) {
		return {
			async resolve({ headers, status, params }) {
				const token = bearerToken(headers.authorization);
				if (!token) return fail(401, 'Unauthorized');

				if (await isAdmin(token)) return;

				// @ts-expect-error - params may be empty or typed by route
				const id = params?.id;

				if (config.scope == 'server' && id) {
					// resolveServer also matches by interfaceName, so a server-scoped token
					// authorizes the same URLs the route handlers themselves resolve - see
					// db/servers.ts.
					const server = await resolveServer(id);

					if (server && server.authToken === token) {
						return;
					}
				}

				if (config.scope == 'peer' && id) {
					const peer = await db.query.peersTable.findFirst({
						where: and(eq(peersTable.id, id), eq(peersTable.authToken, token)),
					});

					if (peer) {
						return;
					}
				}

				return fail(401, 'Unauthorized');
			},
		};
	},

	/**
	 * Authorizes a server-scoped route **and hands the resolved row to the handler** as
	 * `server`. Replaces `verifyAuth: { scope: 'server' }` plus the
	 * resolve-again-and-404-by-hand preamble that used to open all 19 of them - the row was
	 * already read here to check the token and then thrown away. Exposed as `wgServer`
	 * because elysia's context already has a readonly `server`.
	 *
	 * Authorization is decided *before* the 404, deliberately: an unauthenticated caller
	 * gets 401 for a nonexistent server exactly as it did before, so this can't be used to
	 * enumerate server ids.
	 */
	serverScope: {
		async resolve({ headers, status, params }) {
			const token = bearerToken(headers.authorization);
			if (!token) return fail(401, 'Unauthorized');

			const { id } = (params ?? {}) as { id?: string };
			const server = id ? await resolveServer(id) : undefined;

			const authorized = (await isAdmin(token)) || (!!server && server.authToken === token);
			if (!authorized) return fail(401, 'Unauthorized');

			if (!server) return fail(404, 'Server not found');

			// `wgServer`, not `server`: elysia's own context already carries a readonly
			// `server` (the Bun server instance), and shadowing it throws at runtime.
			return { wgServer: server };
		},
	},

	/**
	 * For the nested `/:id/peers/:peerId` routes: authorizes exactly as serverScope does (a
	 * server-scoped token already authorizes every route parameterized by that server's id,
	 * including all of its peers) and additionally resolves the peer *scoped to that server*,
	 * so a peerId from another interface 404s rather than leaking across.
	 */
	serverPeerScope: {
		async resolve({ headers, status, params }) {
			const token = bearerToken(headers.authorization);
			if (!token) return fail(401, 'Unauthorized');

			const { id, peerId } = (params ?? {}) as { id?: string; peerId?: string };
			const server = id ? await resolveServer(id) : undefined;

			const authorized = (await isAdmin(token)) || (!!server && server.authToken === token);
			if (!authorized) return fail(401, 'Unauthorized');

			if (!server) return fail(404, 'Server not found');

			const peer = peerId ? await db.query.peersTable.findFirst({ where: and(eq(peersTable.id, peerId), eq(peersTable.serverPeerId, server.id)) }) : undefined;

			if (!peer) return fail(404, 'Peer not found');

			// `wgServer`, not `server` - see serverScope above.
			return { wgServer: server, peer };
		},
	},

	/**
	 * The peer equivalent of serverScope: authorizes a peer-scoped route by `params.id` and
	 * hands the row to the handler as `peer`.
	 */
	peerScope: {
		async resolve({ headers, status, params }) {
			const token = bearerToken(headers.authorization);
			if (!token) return fail(401, 'Unauthorized');

			const { id } = (params ?? {}) as { id?: string };
			const peer = id ? await db.query.peersTable.findFirst({ where: eq(peersTable.id, id) }) : undefined;

			const authorized = (await isAdmin(token)) || (!!peer && peer.authToken === token);
			if (!authorized) return fail(401, 'Unauthorized');

			if (!peer) return fail(404, 'Peer not found');

			return { peer };
		},
	},
});

export const authRoutes = new Elysia({ prefix: '/auth' })
	.use(auth)
	.post(
		'/login',
		async ({ body, status }) => {
			if (body.token?.trim() !== process.env.ADMIN_TOKEN?.trim()) {
				return fail(401, 'Invalid admin token');
			}

			// Opportunistic cleanup of expired sessions
			await db.delete(adminSessionsTable).where(lt(adminSessionsTable.expiresAt, new Date()));

			const remember = body.remember ?? true;
			const days = body.durationDays ?? (remember ? 7 : 1);
			const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
			const sessionToken = nanoid(48);

			await db.insert(adminSessionsTable).values({
				id: nanoid(),
				token: sessionToken,
				expiresAt,
			});

			return {
				token: sessionToken,
				expiresAt,
			};
		},
		{
			body: t.Object({
				token: t.String(),
				remember: t.Optional(t.Boolean()),
				durationDays: t.Optional(t.Number()),
			}),
		},
	)
	.post(
		'/logout',
		async ({ headers }) => {
			const token = headers.authorization?.split(' ')[1]?.trim();
			if (token) {
				await db.delete(adminSessionsTable).where(eq(adminSessionsTable.token, token));
			}
			return { success: true };
		},
		{
			verifyAuth: {
				scope: 'admin',
			},
		},
	)
	.get(
		'/verify',
		async () => {
			return { valid: true };
		},
		{
			verifyAuth: {
				scope: 'admin',
			},
		},
	);
