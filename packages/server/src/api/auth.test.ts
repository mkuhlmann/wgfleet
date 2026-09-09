import { Elysia } from 'elysia';
import { auth, authRoutes } from './auth';
import { db } from '../db';
import { describe, expect, it } from 'bun:test';
import { adminSessionsTable } from '@server/db/schema';
import { eq } from 'drizzle-orm';

describe('authRouter', () => {
	const app = new Elysia().use(auth).use(authRoutes);

	describe('POST /auth/login', () => {
		it('should reject invalid admin token', async () => {
			const res = await app.handle(
				new Request('http://localhost/auth/login', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ token: 'wrong-token' }),
				})
			);
			expect(res.status).toBe(401);
		});

		it('should return session token and 7-day expiry on success', async () => {
			const res = await app.handle(
				new Request('http://localhost/auth/login', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ token: 'adminToken', remember: true }),
				})
			);
			expect(res.status).toBe(200);
			const data = (await res.json()) as { token: string; expiresAt: string };
			expect(typeof data.token).toBe('string');
			expect(data.token.length).toBeGreaterThan(20);

			const expiresAt = new Date(data.expiresAt).getTime();
			const expectedExpiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
			// Allow 10 second tolerance
			expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(10000);

			// Verify in database
			const session = await db.query.adminSessionsTable.findFirst({
				where: eq(adminSessionsTable.token, data.token),
			});
			expect(session).toBeDefined();
			expect(session?.token).toBe(data.token);
		});

		it('should support custom duration or non-remember login', async () => {
			const res = await app.handle(
				new Request('http://localhost/auth/login', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ token: 'adminToken', remember: false }),
				})
			);
			expect(res.status).toBe(200);
			const data = (await res.json()) as { token: string; expiresAt: string };
			const expiresAt = new Date(data.expiresAt).getTime();
			const expectedExpiry = Date.now() + 1 * 24 * 60 * 60 * 1000;
			expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(10000);
		});
	});

	describe('Session token authorization', () => {
		it('should allow access with valid session token', async () => {
			// First login to obtain token
			const loginRes = await app.handle(
				new Request('http://localhost/auth/login', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ token: 'adminToken' }),
				})
			);
			const loginData = (await loginRes.json()) as { token: string };

			const verifyRes = await app.handle(
				new Request('http://localhost/auth/verify', {
					headers: { authorization: `Bearer ${loginData.token}` },
				})
			);
			expect(verifyRes.status).toBe(200);
			const verifyData = await verifyRes.json();
			expect(verifyData).toEqual({ valid: true });
		});

		it('should still allow access with raw ADMIN_TOKEN', async () => {
			const res = await app.handle(
				new Request('http://localhost/auth/verify', {
					headers: { authorization: 'Bearer adminToken' },
				})
			);
			expect(res.status).toBe(200);
		});

		it('should reject expired session token', async () => {
			const expiredToken = 'expired_test_session_token';
			await db.insert(adminSessionsTable).values({
				token: expiredToken,
				expiresAt: new Date(Date.now() - 1000), // in the past
			});

			const res = await app.handle(
				new Request('http://localhost/auth/verify', {
					headers: { authorization: `Bearer ${expiredToken}` },
				})
			);
			expect(res.status).toBe(401);
		});

		it('should revoke session on logout', async () => {
			// Login
			const loginRes = await app.handle(
				new Request('http://localhost/auth/login', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ token: 'adminToken' }),
				})
			);
			const loginData = (await loginRes.json()) as { token: string };

			// Logout
			const logoutRes = await app.handle(
				new Request('http://localhost/auth/logout', {
					method: 'POST',
					headers: { authorization: `Bearer ${loginData.token}` },
				})
			);
			expect(logoutRes.status).toBe(200);

			// Verification should now fail
			const verifyRes = await app.handle(
				new Request('http://localhost/auth/verify', {
					headers: { authorization: `Bearer ${loginData.token}` },
				})
			);
			expect(verifyRes.status).toBe(401);
		});
	});
});
