import { beforeAll, describe, expect, it } from 'bun:test';
import { db } from '@server/db';
import { peersTable, serverPeersTable, type Peer } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { generateExitLinkConfig, generatePeerConfig, generateServerConfig } from './config';
import { exitTopologyOf } from '@server/lib/exitTopology';

/** The ExitNode projection for one peer - what generateExitLinkConfig takes. */
const exitNodeOf = (peers: Peer[], id: string) => exitTopologyOf(peers).exitNodes.find((node) => node.peer.id === id)!;

// Fixture ids are prefixed per-file: the test run shares one in-memory database across every
// test file (see tests/setup.ts and CLAUDE.md), so unprefixed ids would collide.
const SERVER = 'configTest-server';
const PLAIN = 'configTest-server-plain';
// advertisement-only, and advertisement on the same peer as the exit node - the two features
// compose, and each one on its own has to be enough to turn `Table = off` on.
const ADV = 'configTest-server-adv';
const BOTH = 'configTest-server-both';

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
				},
				{
					id: ADV,
					interfaceName: 'wgCfg2',
					cidrRange: '10.46.46.0/24',
					reservedIps: 10,
					wgAddress: '10.46.46.1',
					wgListenPort: 51946,
					wgEndpoint: 'cfghost:51946',
					wgPrivateKey: 'serverPrivateKey',
					wgPublicKey: 'serverPublicKey',
				},
				{
					id: BOTH,
					interfaceName: 'wgCfg3',
					cidrRange: '10.47.47.0/24',
					reservedIps: 10,
					wgAddress: '10.47.47.1',
					wgListenPort: 51947,
					wgEndpoint: 'cfghost:51947',
					wgPrivateKey: 'serverPrivateKey',
					wgPublicKey: 'serverPublicKey',
				},
			])
			.execute();

		await db
			.insert(peersTable)
			.values([
				{
					id: 'configTest-exit',
					serverPeerId: SERVER,
					wgAddress: '10.44.0.2',
					wgPrivateKey: 'exitPriv',
					wgPublicKey: 'exitPub',
					isExitNode: true,
					exitDns: '9.9.9.9',
					exitInterfaceName: 'wgx0',
					exitPrivateKey: 'exitLinkPriv',
					exitPublicKey: 'exitLinkPub',
					exitListenPort: 51900,
					exitRouteTableId: 52000,
				},
				{ id: 'configTest-client', serverPeerId: SERVER, wgAddress: '10.44.0.3', wgPrivateKey: 'clientPriv', wgPublicKey: 'clientPub', exitPeerId: 'configTest-exit' },
				{ id: 'configTest-plainPeer', serverPeerId: PLAIN, wgAddress: '10.45.45.2', wgPrivateKey: 'plainPriv', wgPublicKey: 'plainPub' },
				{ id: 'configTest-advertiser', serverPeerId: ADV, wgAddress: '10.46.46.2', wgPrivateKey: 'advPriv', wgPublicKey: 'advPub', advertisedRoutes: '192.168.1.0/24,10.10.0.0/16' },
				{ id: 'configTest-advPeer', serverPeerId: ADV, wgAddress: '10.46.46.3', wgPrivateKey: 'advPeerPriv', wgPublicKey: 'advPeerPub' },
				{
					id: 'configTest-both',
					serverPeerId: BOTH,
					wgAddress: '10.47.47.2',
					wgPrivateKey: 'bothPriv',
					wgPublicKey: 'bothPub',
					isExitNode: true,
					advertisedRoutes: '192.168.7.0/24',
					exitInterfaceName: 'wgx1',
					exitPrivateKey: 'bothLinkPriv',
					exitPublicKey: 'bothLinkPub',
					exitListenPort: 51901,
					exitRouteTableId: 52001,
				},
			])
			.execute();
	});

	describe('generateServerConfig', () => {
		it("leaves the exit node off its server's interface entirely - it lives on its own link", async () => {
			// This is what makes more than one exit node per server possible: nothing on this
			// interface owns 0.0.0.0/0, so there is nothing for two of them to fight over.
			const server = (await db.query.serverPeersTable.findFirst({ where: eq(serverPeersTable.id, SERVER) }))!;
			const config = await generateServerConfig(server);

			expect(config).not.toContain('0.0.0.0/0');
			expect(config).not.toContain('exitPub');
			expect(config).toContain('AllowedIPs = 10.44.0.3');
		});

		it('needs no Table = off once the exit node is gone from the interface', async () => {
			// `Table = off` exists to stop wg-quick routing a peer's AllowedIPs. With no /0 and
			// nothing advertised here there is nothing outside cidrRange left to route.
			const server = (await db.query.serverPeersTable.findFirst({ where: eq(serverPeersTable.id, SERVER) }))!;

			expect(await generateServerConfig(server)).not.toContain('Table = off');
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

		it('tolerates a read-only /proc on the gateway rather than aborting its bring-up', async () => {
			// wg-quick runs PostUp under `set -e` and rolls the interface back on a non-zero
			// exit, so a bare `sysctl -w` means a container/LXC gateway - where the value is
			// already 1 but /proc/sys is mounted read-only - never gets a tunnel at all.
			const withNat = await generatePeerConfig(await peer('configTest-exit'), { nat: true });

			expect(withNat).toContain('PostUp = sysctl -q -w net.ipv4.ip_forward=1 || test "$(cat /proc/sys/net/ipv4/ip_forward)" = 1');
		});

		it('resolves the uplink interface on the exit node rather than guessing it here', async () => {
			// The manager cannot see that machine's interfaces, and a wrong guess produces an
			// exit node that looks configured and silently NATs nothing.
			const withNat = await generatePeerConfig(await peer('configTest-exit'), { nat: true });

			expect(withNat).toContain('$(r=$(ip -4 route show default); [[ $r =~ dev[[:space:]]+([^[:space:]]+) ]] && echo ${BASH_REMATCH[1]})');
		});
	});

	describe('generateExitLinkConfig', () => {
		it('gives the exit node an interface of its own, with 0.0.0.0/0 and nothing else on it', async () => {
			const config = generateExitLinkConfig(exitNodeOf([await peer('configTest-exit')], 'configTest-exit'));

			expect(config).toContain('PrivateKey = exitLinkPriv');
			expect(config).toContain('ListenPort = 51900');
			expect(config).toContain('AllowedIPs = 0.0.0.0/0, 10.44.0.2');
			// exactly one peer - that is the whole point, see wg/exitLinks.ts
			expect(config.match(/\[Peer\]/g)).toHaveLength(1);
		});

		it('carries no Address, so it adds no connected route of its own', async () => {
			// The exit node's /32 is installed explicitly by wg/exitRouting.ts instead; an
			// address here would have to duplicate the server's (which the kernel refuses on a
			// second interface) or invent a link subnet.
			expect(generateExitLinkConfig(exitNodeOf([await peer('configTest-exit')], 'configTest-exit'))).not.toContain('Address');
		});

		it('always sets Table = off - this peer owns the default route', async () => {
			expect(generateExitLinkConfig(exitNodeOf([await peer('configTest-exit')], 'configTest-exit'))).toContain('Table = off');
		});

		it('refuses to render a link that was never provisioned rather than emitting a broken one', async () => {
			const unprovisioned = { ...(await peer('configTest-exit')), exitInterfaceName: null, exitListenPort: null, exitRouteTableId: null };

			expect(() => generateExitLinkConfig(exitTopologyOf([unprovisioned]).exitNodes[0])).toThrow();
		});
	});

	describe('multiple exit nodes on one server', () => {
		it('renders one independent link per exit node, each owning 0.0.0.0/0', async () => {
			// The thing a shared interface cannot do: two peers both owning /0, because they are
			// on different devices and so never compete for the prefix.
			const peers = [await peer('configTest-exit'), await peer('configTest-both')];
			const first = generateExitLinkConfig(exitNodeOf(peers, 'configTest-exit'));
			const second = generateExitLinkConfig(exitNodeOf(peers, 'configTest-both'));

			expect(first).toContain('AllowedIPs = 0.0.0.0/0');
			expect(second).toContain('AllowedIPs = 0.0.0.0/0');
			expect(first).toContain('ListenPort = 51900');
			expect(second).toContain('ListenPort = 51901');
			expect(first).not.toBe(second);
		});

		it("points each exit node's own client config at its own link, on the server's host", async () => {
			// Same host as the server (an exit link listens beside it), different port, and the
			// link's hub key rather than the server's.
			const config = await generatePeerConfig(await peer('configTest-exit'));

			expect(config).toContain('Endpoint = cfghost:51900');
			expect(config).toContain('PublicKey = exitLinkPub');
			expect(config).not.toContain('PublicKey = serverPublicKey');
		});

		it('leaves an ordinary peer pointed at the server itself', async () => {
			const config = await generatePeerConfig(await peer('configTest-client'));

			expect(config).toContain('Endpoint = cfghost:51944');
			expect(config).toContain('PublicKey = serverPublicKey');
		});
	});

	describe('advertised subnet routes', () => {
		const serverRow = async (id: string) => (await db.query.serverPeersTable.findFirst({ where: eq(serverPeersTable.id, id) }))!;

		it("appends every advertised prefix to the advertiser's server-side AllowedIPs", async () => {
			const config = await generateServerConfig(await serverRow(ADV));

			expect(config).toContain('AllowedIPs = 10.46.46.2, 192.168.1.0/24, 10.10.0.0/16');
			// no other peer on the interface is affected
			expect(config).toContain('AllowedIPs = 10.46.46.3\n');
		});

		it('sets Table = off for an advertisement-only interface too', async () => {
			// otherwise wg-quick installs these routes as well, and two systems end up managing
			// the same ones - the reconciler in wg/exitRouting.ts could no longer tell a stale
			// route of its own from one wg-quick put there.
			expect(await generateServerConfig(await serverRow(ADV))).toContain('Table = off');
		});

		it('puts a peer that is both exit node and advertiser wholly on its own link', async () => {
			// One peer, one interface: the LAN it advertises moves with it, so the server's own
			// interface is left with neither the /0 nor the advertisement.
			expect(await generateServerConfig(await serverRow(BOTH))).not.toContain('192.168.7.0/24');

			const link = generateExitLinkConfig(exitNodeOf([await peer('configTest-both')], 'configTest-both'));
			// the /0 already covers the LAN - the explicit entry is what makes `wg show` name
			// the owner of that prefix
			expect(link).toContain('AllowedIPs = 0.0.0.0/0, 10.47.47.2, 192.168.7.0/24');
		});

		it("leaves the advertiser's own client config unchanged - it is the gateway, not a client of it", async () => {
			const config = await generatePeerConfig(await peer('configTest-advertiser'));

			expect(config).toContain('AllowedIPs = 10.46.46.0/24');
		});

		it("scopes the advertiser's ?nat= masquerade to the vpn subnet and its lan interface", async () => {
			// A blanket masquerade (what an exit node gets) would also rewrite the machine's own
			// LAN traffic; and the LAN interface, like the exit node's uplink, can only be
			// resolved on that machine.
			const withNat = await generatePeerConfig(await peer('configTest-advertiser'), { nat: true });

			expect(withNat).toContain('net.ipv4.ip_forward=1');
			expect(withNat).toContain('PostUp = iptables -t nat -A POSTROUTING -s 10.46.46.0/24 -o $(r=$(ip -4 route show 192.168.1.0/24); [[ $r =~ dev[[:space:]]+([^[:space:]]+) ]] && echo ${BASH_REMATCH[1]}) -j MASQUERADE');
			expect(withNat).toContain('PostDown = iptables -t nat -D POSTROUTING -s 10.46.46.0/24 -o $(r=$(ip -4 route show 10.10.0.0/16); [[ $r =~ dev[[:space:]]+([^[:space:]]+) ]] && echo ${BASH_REMATCH[1]}) -j MASQUERADE');
			// not the exit node's blanket rule
			expect(withNat).not.toContain('-o $(r=$(ip -4 route show default');
		});

		it('gives a peer that is both roles both masquerade rules', async () => {
			const withNat = await generatePeerConfig(await peer('configTest-both'), { nat: true });

			expect(withNat).toContain('-o $(r=$(ip -4 route show default); [[ $r =~ dev[[:space:]]+([^[:space:]]+) ]] && echo ${BASH_REMATCH[1]}) -j MASQUERADE');
			expect(withNat).toContain('-s 10.47.47.0/24 -o $(r=$(ip -4 route show 192.168.7.0/24); [[ $r =~ dev[[:space:]]+([^[:space:]]+) ]] && echo ${BASH_REMATCH[1]}) -j MASQUERADE');
		});
	});
});
