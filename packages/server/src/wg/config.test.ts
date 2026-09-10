import { beforeAll, describe, expect, it } from 'bun:test';
import { db } from '@server/db';
import { peersTable, serverPeersTable, type Peer } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { generatePeerConfig, generateServerConfig } from './config';

// Fixture ids are prefixed per-file: the test run shares one in-memory database across every
// test file (see tests/setup.ts and CLAUDE.md), so unprefixed ids would collide.
const SERVER = 'configTest-server';
const PLAIN = 'configTest-server-plain';

const peer = async (id: string): Promise<Peer> => (await db.query.peersTable.findFirst({ where: eq(peersTable.id, id) }))!;

describe('wg config generation', () => {
	beforeAll(async () => {
		await db
			.insert(serverPeersTable)
			.values([
				{
					id: SERVER,
					interfaceName: 'wgCfg0',
					cidrRange: '10.44.0.0/16',
					reservedIps: 10,
					wgAddress: '10.44.0.1',
					wgListenPort: 51944,
					wgEndpoint: 'cfghost:51944',
					wgPrivateKey: 'serverPrivateKey',
					wgPublicKey: 'serverPublicKey',
					routeTableId: 52900,
					dns: '10.44.0.1',
				},
				{
					id: PLAIN,
					interfaceName: 'wgCfg1',
					cidrRange: '10.45.45.0/24',
					reservedIps: 10,
					wgAddress: '10.45.45.1',
					wgListenPort: 51945,
					wgEndpoint: 'cfghost:51945',
					wgPrivateKey: 'serverPrivateKey',
					wgPublicKey: 'serverPublicKey',
					routeTableId: 52901,
				},
			])
			.execute();

		await db
			.insert(peersTable)
			.values([
				{ id: 'configTest-exit', serverPeerId: SERVER, wgAddress: '10.44.0.2', wgPrivateKey: 'exitPriv', wgPublicKey: 'exitPub', isExitNode: true, exitDns: '9.9.9.9' },
				{ id: 'configTest-client', serverPeerId: SERVER, wgAddress: '10.44.0.3', wgPrivateKey: 'clientPriv', wgPublicKey: 'clientPub', exitPeerId: 'configTest-exit' },
				{ id: 'configTest-plainPeer', serverPeerId: PLAIN, wgAddress: '10.45.45.2', wgPrivateKey: 'plainPriv', wgPublicKey: 'plainPub' },
			])
			.execute();
	});

	describe('generateServerConfig', () => {
		it('gives the exit node 0.0.0.0/0 while every other peer keeps its /32', async () => {
			const server = (await db.query.serverPeersTable.findFirst({ where: eq(serverPeersTable.id, SERVER) }))!;
			const config = await generateServerConfig(server);

			expect(config).toContain('AllowedIPs = 0.0.0.0/0, 10.44.0.2/32');
			expect(config).toContain('AllowedIPs = 10.44.0.3');
		});

		it('sets Table = off on an interface with an exit node, so wg-quick cannot hijack the host default route', async () => {
			const server = (await db.query.serverPeersTable.findFirst({ where: eq(serverPeersTable.id, SERVER) }))!;

			expect(await generateServerConfig(server)).toContain('Table = off');
		});

		it('leaves an interface without an exit node byte-identical to before (no Table line)', async () => {
			const server = (await db.query.serverPeersTable.findFirst({ where: eq(serverPeersTable.id, PLAIN) }))!;
			const config = await generateServerConfig(server);

			expect(config).not.toContain('Table');
			expect(config).toContain('Address = 10.45.45.1/24');
		});

		it('derives the interface Address prefix from cidrRange rather than assuming /24', async () => {
			// With Table = off the connected route from this prefix is the only thing making the
			// server's peers routable - a hardcoded /24 on a /16 server blackholes most of them.
			const server = (await db.query.serverPeersTable.findFirst({ where: eq(serverPeersTable.id, SERVER) }))!;

			expect(await generateServerConfig(server)).toContain('Address = 10.44.0.1/16');
		});
	});

	describe('generatePeerConfig', () => {
		it('renders the normal variant with the server cidr and no v6', async () => {
			const config = await generatePeerConfig(await peer('configTest-client'));

			expect(config).toContain('AllowedIPs = 10.44.0.0/16');
			expect(config).not.toContain('::/0');
		});

		it('renders the exit variant with 0.0.0.0/0 plus ::/0 so v6 is blackholed rather than leaked', async () => {
			const config = await generatePeerConfig(await peer('configTest-client'), { exit: true });

			expect(config).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
		});

		it('differs from the normal variant only in AllowedIPs and DNS - same key, same address', async () => {
			const client = await peer('configTest-client');
			const normal = await generatePeerConfig(client);
			const exit = await generatePeerConfig(client, { exit: true });

			expect(exit).toContain('PrivateKey = clientPriv');
			expect(normal).toContain('PrivateKey = clientPriv');
			expect(exit).toContain('Address = 10.44.0.3/32');
			expect(normal).toContain('Address = 10.44.0.3/32');
			expect(exit).toContain('Endpoint = cfghost:51944');
			expect(normal).toContain('Endpoint = cfghost:51944');
		});

		it("prefers the exit node's own resolver in the exit variant and the server's elsewhere", async () => {
			const client = await peer('configTest-client');

			expect(await generatePeerConfig(client, { exit: true })).toContain('DNS = 9.9.9.9');
			expect(await generatePeerConfig(client)).toContain('DNS = 10.44.0.1');
		});

		it('omits the DNS line entirely when neither the server nor the exit node sets one', async () => {
			expect(await generatePeerConfig(await peer('configTest-plainPeer'))).not.toContain('DNS');
		});

		it('appends the gateway PostUp/PostDown block only when nat is requested', async () => {
			const exitPeer = await peer('configTest-exit');

			expect(await generatePeerConfig(exitPeer)).not.toContain('PostUp');

			const withNat = await generatePeerConfig(exitPeer, { nat: true });
			expect(withNat).toContain('net.ipv4.ip_forward=1');
			expect(withNat).toContain('-j MASQUERADE');
			expect(withNat).toContain('PostDown = iptables -t nat -D POSTROUTING');
		});

		it('resolves the uplink interface on the exit node rather than guessing it here', async () => {
			// The manager cannot see that machine's interfaces, and a wrong guess produces an
			// exit node that looks configured and silently NATs nothing.
			const withNat = await generatePeerConfig(await peer('configTest-exit'), { nat: true });

			expect(withNat).toContain('$(ip -4 route show default');
		});
	});
});
