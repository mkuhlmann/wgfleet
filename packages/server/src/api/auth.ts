import { Elysia, t } from 'elysia';
import { db } from '@server/db';
import { adminSessionsTable, peersTable } from '@server/db/schema';
import { and, eq, gt, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { resolveServer } from '@server/db/servers';

export const auth = new Elysia({ name: 'auth' }).macro({
	verifyAuth(
		config: {
			scope?: 'admin' | 'server' | 'peer';
		} = {
			scope: 'admin',
		}
	) {
		return {
			async resolve({ headers, status, params }) {
				if (!headers.authorization) {
					return status(401);
				}

				const token = headers.authorization.split(' ')[1]?.trim();
				if (!token) {
					return status(401);
				}

				if (token === process.env.ADMIN_TOKEN?.trim()) {
					return;
				}

				const session = await db.query.adminSessionsTable.findFirst({
					where: and(eq(adminSessionsTable.token, token), gt(adminSessionsTable.expiresAt, new Date())),
				});

				if (session) {
					return;
				}

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

				return status(401);
			},
		};
	},
});

export const authRoutes = new Elysia({ prefix: '/auth' })
	.use(auth)
	.post(
		'/login',
		async ({ body, status }) => {
			if (body.token?.trim() !== process.env.ADMIN_TOKEN?.trim()) {
				return status(401, 'Invalid admin token');
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
		}
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
		}
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
		}
	);
