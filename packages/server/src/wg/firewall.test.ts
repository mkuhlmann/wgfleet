import { describe, expect, it } from 'bun:test';
import { buildRuleset } from './firewall';
import { graphOf, type GraphSpec, type PeerSpec } from '@server/tests/graphs';

// buildRuleset takes the fleet snapshot (db/fleet.ts), so these drive the same rows the db
// returns - including the projection that resolves tags to member ips, decides which peers are
// governed and drops unresolvable grants. That projection used to sit above this seam, which
// meant the fixtures here re-enacted it by hand and nothing verified it.
const server = (spec: GraphSpec = {}) => graphOf(spec);

/** An exit node and one client of it, as a pair of peer rows. */
const exitNodeWith = (spec: { id?: string; ip?: string; interfaceName?: string; routeTableId?: number; clientIps?: string[]; provisioned?: boolean } = {}): PeerSpec[] => {
	const id = spec.id ?? 'n0';
	const clientIps = spec.clientIps ?? ['10.20.20.3'];

	return [
		{
			id,
			ip: spec.ip ?? '10.20.20.2',
			isExitNode: true,
			link: spec.provisioned === false ? null : { interfaceName: spec.interfaceName ?? 'wgx0', listenPort: 51900, routeTableId: spec.routeTableId ?? 52000 },
		},
		...clientIps.map((ip, i) => ({ id: `${id}-c${i}`, ip, exitPeerId: id })),
	];
};

describe('buildRuleset', () => {
	it('wraps every ruleset in the atomic create/delete/recreate idiom', () => {
		const ruleset = buildRuleset([]);
		expect(ruleset).toStartWith('table inet wgmgr {}\ndelete table inet wgmgr\ntable inet wgmgr {\n');
	});

	it('emits no fwd_*/in_* chains and no jumps when no tags/grants exist anywhere', () => {
		const ruleset = buildRuleset([server()]);

		expect(ruleset).not.toContain('jump');
		expect(ruleset).not.toContain('chain input');
		expect(ruleset).not.toContain('chain postrouting');
		expect(ruleset).toContain('chain forward {');
		expect(ruleset).toContain('ct state established,related accept');
		// only the baseline invalid-state drop is present - no tag/grant/egress drops
		expect(ruleset.match(/\bdrop\b/g)).toEqual(['drop']);
	});

	it('emits a member set and a dispatch chain for a tag with members', () => {
		const ruleset = buildRuleset([
			server({
				tags: [{ id: 't-office', name: 'office' }],
				peers: [
					{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] },
					{ id: 'p1', ip: '10.20.20.5', tags: ['t-office'] },
				],
			}),
		]);

		expect(ruleset).toContain('set s0t0 {');
		expect(ruleset).toContain('elements = { 10.20.20.2, 10.20.20.5 }');
		expect(ruleset).toContain('comment "office"');
		expect(ruleset).toContain('chain fwd_s0 {');
		// governed (tagged), no grants at all -> default-deny, not unrestricted
		expect(ruleset).toMatch(/chain fwd_s0 \{\s*\n\s*meta nfproto ipv6 drop\s*\n\s*ip saddr @s0_governed drop\s*\n\s*return\s*\n\s*\}/);
	});

	it('does not emit an elements line for an empty tag', () => {
		const ruleset = buildRuleset([
			server({
				tags: [
					{ id: 't-empty', name: 'empty' },
					{ id: 't-office', name: 'office' },
				],
				peers: [{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] }],
			}),
		]);

		expect(ruleset).not.toContain('elements = {  }');
		expect(ruleset).not.toContain('elements = { }');
		expect(ruleset).toMatch(/set s0t0 \{\s*\n\s*type ipv4_addr\s*\n\s*comment "empty"\s*\n\s*\}/);
	});

	it('drops a stale assignment naming a peer that no longer exists', () => {
		// the assignment outlives the peer (sqlite FK enforcement is off - see CLAUDE.md), and
		// one dangling row must not take the whole tag - or the whole ruleset - with it
		const graph = server({ tags: [{ id: 't-office', name: 'office' }], peers: [{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] }] });
		graph.assignments.push({ id: 'stale', createdAt: new Date(0), peerId: 'deleted-peer', tagId: 't-office' });

		const ruleset = buildRuleset([graph]);

		expect(ruleset).toContain('elements = { 10.20.20.2 }');
		expect(ruleset).not.toContain('deleted-peer');
	});

	it('scopes sets and chains per-server, even with overlapping CIDRs', () => {
		const ruleset = buildRuleset([
			server({ id: 's0', interfaceName: 'wg0', cidrRange: '10.0.0.0/24', tags: [{ id: 'a-office', name: 'office' }], peers: [{ id: 'a0', ip: '10.0.0.2', tags: ['a-office'] }] }),
			// same ip, different server
			server({ id: 's1', interfaceName: 'wg1', cidrRange: '10.0.0.0/24', tags: [{ id: 'b-office', name: 'office' }], peers: [{ id: 'b0', ip: '10.0.0.2', tags: ['b-office'] }] }),
		]);

		expect(ruleset).toContain('iifname "wg0" jump fwd_s0');
		expect(ruleset).toContain('iifname "wg1" jump fwd_s1');
		expect(ruleset).toContain('set s0t0 {');
		expect(ruleset).toContain('set s1t0 {');
		expect(ruleset).toContain('chain fwd_s0 {');
		expect(ruleset).toContain('chain fwd_s1 {');
	});

	it('grants a directional tag -> tag rule without granting the reverse', () => {
		const ruleset = buildRuleset([
			server({
				tags: [
					{ id: 't-office', name: 'office' },
					{ id: 't-db', name: 'db' },
				],
				peers: [
					{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] },
					{ id: 'p1', ip: '10.20.20.9', tags: ['t-db'] },
				],
				grants: [{ srcTag: 't-office', dstTag: 't-db' }],
			}),
		]);

		expect(ruleset).toContain('ip saddr @s0t0 ip daddr @s0t1 accept');
		// only office (s0t0) was granted db (s0t1) as a destination - the reverse
		// accept (db -> office) must not appear anywhere in the ruleset
		expect(ruleset).not.toContain('ip saddr @s0t1 ip daddr @s0t0 accept');
	});

	it('denies intra-tag traffic unless a self-referencing grant is explicitly added', () => {
		const peers: PeerSpec[] = [
			{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] },
			{ id: 'p1', ip: '10.20.20.3', tags: ['t-office'] },
		];
		const withoutSelfGrant = buildRuleset([server({ tags: [{ id: 't-office', name: 'office' }], peers })]);
		expect(withoutSelfGrant).not.toContain('ip saddr @s0t0 ip daddr @s0t0 accept');

		const withSelfGrant = buildRuleset([server({ tags: [{ id: 't-office', name: 'office' }], peers, grants: [{ srcTag: 't-office', dstTag: 't-office' }] })]);
		expect(withSelfGrant).toContain('ip saddr @s0t0 ip daddr @s0t0 accept');
	});

	it('allows a dstCidr target', () => {
		const ruleset = buildRuleset([
			server({
				tags: [{ id: 't-office', name: 'office' }],
				peers: [{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] }],
				grants: [{ srcTag: 't-office', dstCidr: '192.168.50.0/24' }],
			}),
		]);

		expect(ruleset).toContain('ip daddr 192.168.50.0/24 accept');
	});

	it('drops a grant with an ipv6 dstCidr rather than emitting an invalid `ip daddr <ipv6>` line', () => {
		// regression: `ip daddr` is the ipv4-specific match - handing it an ipv6
		// literal is an nft type error (`nft -f` exits 1), not something nft
		// tolerates. A stray ipv6 rule must not be able to break every future sync.
		const ruleset = buildRuleset([
			server({
				tags: [{ id: 't-office', name: 'office' }],
				peers: [{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] }],
				grants: [
					{ srcTag: 't-office', dstCidr: 'fd00::/64' },
					{ srcTag: 't-office', dstCidr: '192.168.50.0/24' },
				],
			}),
		]);

		expect(ruleset).not.toContain('fd00::');
		expect(ruleset).toContain('ip daddr 192.168.50.0/24 accept');
	});

	it('ignores a grant with an unresolvable tag reference rather than breaking the ruleset', () => {
		const ruleset = buildRuleset([
			server({
				tags: [{ id: 't-office', name: 'office' }],
				peers: [{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] }],
				grants: [{ srcTag: 't-office', dstTag: 't-deleted' }],
			}),
		]);

		expect(ruleset).not.toContain('t-deleted');
		expect(ruleset).toMatch(/chain fwd_s0 \{\s*\n\s*meta nfproto ipv6 drop\s*\n\s*ip saddr @s0_governed drop\s*\n\s*return\s*\n\s*\}/);
	});

	it('ignores a grant whose source peer no longer exists, without governing anything else', () => {
		const ruleset = buildRuleset([
			server({
				peers: [{ id: 'p0', ip: '10.20.20.2' }],
				grants: [{ srcPeer: 'deleted-peer', dst: 'any' }],
			}),
		]);

		// the only grant was dropped, so nothing is governed and no chain is emitted at all
		expect(ruleset).not.toContain('chain fwd_s0');
		expect(ruleset).not.toContain('deleted-peer');
	});

	it('governs a peer named directly as a grant source, even with no tags at all', () => {
		const ruleset = buildRuleset([
			server({
				peers: [
					{ id: 'p0', ip: '10.20.20.2' },
					{ id: 'p1', ip: '10.20.20.3' },
				],
				grants: [{ srcPeer: 'p0', dst: 'any' }],
			}),
		]);

		// p0 is governed by being named; p1 is untouched and stays unrestricted
		expect(ruleset).toContain('set s0_governed {');
		expect(ruleset).toContain('elements = { 10.20.20.2 }');
		expect(ruleset).not.toContain('10.20.20.3');
	});

	it('routes governed traffic to the input chain only via dstKind server/any grants', () => {
		const ruleset = buildRuleset([
			server({
				tags: [{ id: 't-office', name: 'office' }],
				peers: [{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] }],
				grants: [{ srcTag: 't-office', dst: 'server' }],
			}),
		]);

		expect(ruleset).toContain('chain input {');
		expect(ruleset).toContain('iifname "wg0" ip saddr @s0_governed jump in_s0');
		expect(ruleset).toMatch(/chain in_s0 \{\s*\n\s*meta nfproto ipv6 drop\n\s*ip saddr @s0t0 accept\s*\n\s*drop\s*\n\s*\}/);
		// a server-dst grant must not also show up in the forward chain
		const fwdBody = ruleset.match(/chain fwd_s0 \{([\s\S]*?)\n\t\}/)![1];
		expect(fwdBody).not.toContain('accept');
	});

	it('drops governed traffic to the gateway by default when no server-dst grant exists', () => {
		const ruleset = buildRuleset([server({ tags: [{ id: 't-office', name: 'office' }], peers: [{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] }] })]);

		expect(ruleset).toMatch(/chain in_s0 \{\s*\n\s*meta nfproto ipv6 drop\n\s*drop\s*\n\s*\}/);
	});

	it('a dstKind any grant applies to both the forward and input chains', () => {
		const ruleset = buildRuleset([
			server({
				tags: [{ id: 't-office', name: 'office' }],
				peers: [{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] }],
				grants: [{ srcTag: 't-office', dst: 'any' }],
			}),
		]);

		expect(ruleset).toMatch(/chain fwd_s0 \{[\s\S]*ip saddr @s0t0 accept/);
		expect(ruleset).toMatch(/chain in_s0 \{[\s\S]*ip saddr @s0t0 accept/);
	});

	it('skips a disabled grant but keeps its source governed', () => {
		const ruleset = buildRuleset([
			server({
				tags: [{ id: 't-office', name: 'office' }],
				peers: [{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] }],
				grants: [{ srcTag: 't-office', dst: 'any', enabled: false }],
			}),
		]);

		expect(ruleset).not.toContain('ip saddr @s0t0 accept');
		// tagged, so still default-denied rather than silently unrestricted
		expect(ruleset).toContain('ip saddr @s0_governed drop');
	});

	it('evaluates grants in order, first match wins', () => {
		const ruleset = buildRuleset([
			server({
				tags: [
					{ id: 't-office', name: 'office' },
					{ id: 't-db', name: 'db' },
				],
				peers: [
					{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] },
					{ id: 'p1', ip: '10.20.20.9', tags: ['t-db'] },
				],
				grants: [
					{ action: 'deny', srcTag: 't-office', dstTag: 't-db' },
					{ action: 'allow', srcTag: 't-office', dstTag: 't-db' },
				],
			}),
		]);

		const fwd = ruleset.match(/chain fwd_s0 \{([\s\S]*?)\n\t\}/)![1];
		const dropIdx = fwd.indexOf('drop');
		const acceptIdx = fwd.indexOf('accept');
		expect(dropIdx).toBeGreaterThan(-1);
		expect(acceptIdx).toBeGreaterThan(dropIdx); // the deny rule (drop) must precede the allow rule
	});

	it('lets a peer-scoped grant placed above a tag-scoped one override it (per-client precedence)', () => {
		const ruleset = buildRuleset([
			server({
				tags: [
					{ id: 't-dev', name: 'dev' },
					{ id: 't-db', name: 'db' },
				],
				peers: [
					{ id: 'p0', ip: '10.20.20.2', tags: ['t-dev'] },
					{ id: 'p1', ip: '10.20.20.3', tags: ['t-dev'] },
					{ id: 'p2', ip: '10.20.20.9', tags: ['t-db'] },
				],
				grants: [
					{ action: 'deny', srcPeer: 'p0', dstTag: 't-db' },
					{ action: 'allow', srcTag: 't-dev', dstTag: 't-db' },
				],
			}),
		]);

		expect(ruleset).toContain('ip saddr 10.20.20.2 ip daddr @s0t1 drop');
		const fwd = ruleset.match(/chain fwd_s0 \{([\s\S]*?)\n\t\}/)![1];
		expect(fwd.indexOf('ip saddr 10.20.20.2 ip daddr @s0t1 drop')).toBeLessThan(fwd.indexOf('ip saddr @s0t0 ip daddr @s0t1 accept'));
	});

	it('renders tcp/udp port lists and ranges, and a bare protocol match with no ports', () => {
		const ruleset = buildRuleset([
			server({
				tags: [
					{ id: 't-dev', name: 'dev' },
					{ id: 't-db', name: 'db' },
				],
				peers: [
					{ id: 'p0', ip: '10.20.20.2', tags: ['t-dev'] },
					{ id: 'p1', ip: '10.20.20.9', tags: ['t-db'] },
				],
				grants: [
					{ srcTag: 't-dev', dstTag: 't-db', protocol: 'tcp', ports: '22, 8000-8100' },
					{ srcTag: 't-dev', dstTag: 't-db', protocol: 'udp' },
					{ srcTag: 't-dev', dstTag: 't-db', protocol: 'icmp' },
				],
			}),
		]);

		expect(ruleset).toContain('tcp dport { 22, 8000-8100 } accept');
		expect(ruleset).toContain('meta l4proto udp accept');
		expect(ruleset).toContain('meta l4proto icmp accept');
	});

	it('attaches a sanitized nft comment to a grant', () => {
		const ruleset = buildRuleset([
			server({
				tags: [
					{ id: 't-dev', name: 'dev' },
					{ id: 't-db', name: 'db' },
				],
				peers: [
					{ id: 'p0', ip: '10.20.20.2', tags: ['t-dev'] },
					{ id: 'p1', ip: '10.20.20.9', tags: ['t-db'] },
				],
				grants: [{ srcTag: 't-dev', dstTag: 't-db', comment: 'db access for "dev"' }],
			}),
		]);

		expect(ruleset).toContain('comment "db access for dev"');
	});

	it("uses a tag's friendlyName for the nft comment when it has one", () => {
		const ruleset = buildRuleset([
			server({
				tags: [{ id: 't-office', name: 'office', friendlyName: 'Head Office' }],
				peers: [{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] }],
			}),
		]);

		expect(ruleset).toContain('comment "Head Office"');
	});

	it('never masquerades and never guards egress - the hub is not a gateway', () => {
		// Hub egress was removed (drizzle/0008_drop_hub_egress.sql): with no masquerade there
		// is no egress path to permit, deny or guard, so the ruleset carries no nat hook and no
		// oifname-based rule at all. A client reaches the internet through an exit node peer,
		// whose traffic never leaves the wg interface here.
		const ruleset = buildRuleset([
			server({
				tags: [{ id: 't-office', name: 'office' }],
				peers: [{ id: 'p0', ip: '10.20.20.2', tags: ['t-office'] }],
				grants: [{ srcTag: 't-office', dst: 'any' }],
			}),
			server({ id: 's1', interfaceName: 'wg1' }),
		]);

		expect(ruleset).not.toContain('chain postrouting');
		expect(ruleset).not.toContain('masquerade');
		expect(ruleset).not.toContain('oifname !=');
	});

	describe('exit nodes', () => {
		it("accepts an exit client's internet-bound traffic leaving via that exit node's own link", () => {
			// No destination a grant can name matches exit traffic: it leaves *via* the exit
			// link towards the exit node. Without this rule a governed exit client would be
			// dropped by the default-deny and its exit node would silently do nothing.
			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', peers: exitNodeWith() })]);

			expect(ruleset).toContain('elements = { 10.20.20.3 }');
			expect(ruleset).toContain('ip saddr @s0e0 oifname "wgx0" ip daddr != 10.20.20.0/24 accept');
		});

		it("pins each exit node to its own link, so a client cannot leave through somebody else's", () => {
			// Routing already guarantees this (a client's ip rule names exactly one table), but
			// a single shared accept would quietly permit any exit client down any exit link.
			const ruleset = buildRuleset([
				server({
					cidrRange: '10.20.20.0/24',
					peers: [...exitNodeWith({ id: 'n0', ip: '10.20.20.2', interfaceName: 'wgx0', clientIps: ['10.20.20.3'] }), ...exitNodeWith({ id: 'n1', ip: '10.20.20.4', interfaceName: 'wgx1', routeTableId: 52001, clientIps: ['10.20.20.5'] })],
				}),
			]);

			expect(ruleset).toContain('ip saddr @s0e0 oifname "wgx0" ip daddr != 10.20.20.0/24 accept');
			expect(ruleset).toContain('ip saddr @s0e1 oifname "wgx1" ip daddr != 10.20.20.0/24 accept');
			// and each set holds only its own node's clients
			expect(ruleset).toContain('set s0e0 {\n\t\ttype ipv4_addr\n\t\tcomment "clients of exit node 10.20.20.2"\n\t\telements = { 10.20.20.3 }');
			expect(ruleset).toContain('set s0e1 {\n\t\ttype ipv4_addr\n\t\tcomment "clients of exit node 10.20.20.4"\n\t\telements = { 10.20.20.5 }');
		});

		it("sends every one of a server's interfaces into the same chain, so an exit node stays governed", () => {
			// An exit node is a peer of this server that happens to live on its own interface -
			// without a jump for that interface its own traffic would bypass policy entirely.
			const peers = exitNodeWith();
			peers[0].tags = ['t-office'];

			const ruleset = buildRuleset([server({ tags: [{ id: 't-office', name: 'office' }], peers })]);

			expect(ruleset).toContain('iifname "wg0" jump fwd_s0');
			expect(ruleset).toContain('iifname "wgx0" jump fwd_s0');
			expect(ruleset).toContain('iifname "wgx0" ip saddr @s0_governed jump in_s0');
		});

		it('scopes the accept to internet-bound traffic, leaving peer-to-peer entirely to grants', () => {
			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', peers: exitNodeWith() })]);

			// `ip daddr != cidrRange` is what keeps it from being a blanket allow within the vpn
			expect(ruleset).toContain('ip daddr != 10.20.20.0/24');
		});

		it('places the exit accept after every explicit grant, so a deny above it still wins', () => {
			const peers = exitNodeWith();
			peers[1].tags = ['t-office'];

			const ruleset = buildRuleset([
				server({
					cidrRange: '10.20.20.0/24',
					tags: [{ id: 't-office', name: 'office' }],
					peers,
					grants: [{ action: 'deny', srcTag: 't-office', dst: 'any' }],
				}),
			]);

			const denyAt = ruleset.indexOf('ip saddr @s0t0 drop');
			const exitAt = ruleset.indexOf('@s0e0');

			expect(denyAt).toBeGreaterThanOrEqual(0);
			expect(exitAt).toBeGreaterThan(denyAt);
		});

		it('emits the exit chain even for a server with no tags and no grants', () => {
			// the exit-client accept is the only policy such a server has - skipping the
			// chain (as an entirely policy-free server does) would drop it with the chain
			const ruleset = buildRuleset([server({ peers: exitNodeWith() })]);

			expect(ruleset).toContain('chain fwd_s0 {');
		});

		it('emits nothing for an exit node with no clients assigned', () => {
			const ruleset = buildRuleset([server({ peers: exitNodeWith({ clientIps: [] }) })]);

			expect(ruleset).not.toContain('s0e0');
			expect(ruleset).not.toContain('chain fwd_s0 {');
		});

		it('keeps exit clients out of the governed set, so assigning an exit node does not lock a peer down', () => {
			const ruleset = buildRuleset([server({ peers: exitNodeWith() })]);

			// s0_governed is emitted but empty - an exit client with no tags stays ungoverned
			expect(ruleset).toContain('set s0_governed {');
			expect(ruleset).not.toContain('set s0_governed {\n\t\ttype ipv4_addr\n\t\telements');
		});

		it('omits the exit accept for an exit node whose link is not provisioned yet', () => {
			// An exit node reaches converge before its link exists (reconcileExitLinks allocates
			// it), and an accept naming an interface that isn't there yet would be a dangling
			// rule. The projection drops it - the same state the config and routing layers see.
			const peers = exitNodeWith({ provisioned: false });
			peers[1].tags = ['t-office'];

			const ruleset = buildRuleset([server({ tags: [{ id: 't-office', name: 'office' }], peers })]);

			expect(ruleset).not.toContain('s0e0');
			const fwdBody = ruleset.match(/chain fwd_s0 \{([\s\S]*?)\n\t\}/)![1];
			expect(fwdBody).not.toContain('accept');
		});
	});

	describe('advertised subnet routes', () => {
		it('needs no rule of its own - a cidr-dst grant already compiles to the accept', () => {
			const ruleset = buildRuleset([
				server({
					tags: [{ id: 't-office', name: 'office' }],
					peers: [
						{ id: 'p0', ip: '10.20.20.3', tags: ['t-office'] },
						{ id: 'adv', ip: '10.20.20.7', advertisedRoutes: '192.168.1.0/24' },
					],
					grants: [{ srcTag: 't-office', dstCidr: '192.168.1.0/24' }],
				}),
			]);

			expect(ruleset).toContain('ip saddr @s0t0 ip daddr 192.168.1.0/24 accept');
		});

		it('changes nothing at all on an interface with no exit clients', () => {
			// the column is invisible to the firewall except through the exit accept below
			const withRoutes = buildRuleset([server({ tags: [{ id: 't-office' }], peers: [{ id: 'p0', ip: '10.20.20.3', tags: ['t-office'], advertisedRoutes: '192.168.1.0/24' }] })]);
			const without = buildRuleset([server({ tags: [{ id: 't-office' }], peers: [{ id: 'p0', ip: '10.20.20.3', tags: ['t-office'] }] })]);

			expect(withRoutes).toBe(without);
		});

		it('excludes an advertised LAN from the exit accept, so reaching it still needs a grant', () => {
			// Without this, a governed exit client would reach every advertised LAN on the
			// interface for free: that traffic leaves via the same wg interface and is neither
			// inside cidrRange nor matched by an `internet`-dst grant. Advertising deliberately
			// adds no permission mechanism, so the grants list has to stay the only way in.
			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', peers: [...exitNodeWith(), { id: 'adv', ip: '10.20.20.7', advertisedRoutes: '192.168.1.0/24' }] })]);

			expect(ruleset).toContain('ip saddr @s0e0 oifname "wgx0" ip daddr != { 10.20.20.0/24, 192.168.1.0/24 } accept');
		});

		it('excludes a LAN advertised by the exit node itself, not just by an ordinary peer', () => {
			const peers = exitNodeWith();
			peers[0].advertisedRoutes = '192.168.9.0/24';

			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', peers })]);

			expect(ruleset).toContain('ip daddr != { 10.20.20.0/24, 192.168.9.0/24 } accept');
		});

		it('keeps the single-prefix form when nothing is advertised', () => {
			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', peers: exitNodeWith() })]);

			expect(ruleset).toContain('ip daddr != 10.20.20.0/24 accept');
		});

		it('a grant above the exit accept still lets an exit client reach an advertised LAN', () => {
			const peers = exitNodeWith();
			peers[1].tags = ['t-office'];

			const ruleset = buildRuleset([
				server({
					cidrRange: '10.20.20.0/24',
					tags: [{ id: 't-office', name: 'office' }],
					peers: [...peers, { id: 'adv', ip: '10.20.20.7', advertisedRoutes: '192.168.1.0/24' }],
					grants: [{ srcTag: 't-office', dstCidr: '192.168.1.0/24' }],
				}),
			]);

			const grantAt = ruleset.indexOf('ip daddr 192.168.1.0/24 accept');
			const exitAt = ruleset.indexOf('@s0e0');

			expect(grantAt).toBeGreaterThanOrEqual(0);
			expect(grantAt).toBeLessThan(exitAt);
		});

		it('ignores a non-ipv4 advertised prefix rather than emitting an nft type error', () => {
			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', peers: [...exitNodeWith(), { id: 'adv', ip: '10.20.20.7', advertisedRoutes: 'fd00::/64' }] })]);

			expect(ruleset).toContain('ip daddr != 10.20.20.0/24 accept');
			expect(ruleset).not.toContain('fd00');
		});
	});
});

describe('buildRuleset - the server as an exit node', () => {
	it('masquerades exactly the clients that selected it, and nobody else', () => {
		// Scoping the masquerade to the selected set is what replaces the egress guard the old
		// `enableNat` needed: a peer that did not select this exit still leaves with its vpn
		// source address, which nothing can route a reply back to.
		const ruleset = buildRuleset([
			graphOf({
				isExitNode: true,
				peers: [
					{ id: 'p1', ip: '10.20.20.2', exitViaServer: true },
					{ id: 'p2', ip: '10.20.20.3' },
				],
			}),
		]);

		expect(ruleset).toContain('set s0_serverexit {');
		expect(ruleset).toContain('elements = { 10.20.20.2 }');
		expect(ruleset).toContain('chain postrouting {');
		expect(ruleset).toContain('ip saddr @s0_serverexit oifname != { "wg0" } masquerade');
		// no blanket cidrRange masquerade, and so no guard rule needed to claw it back
		expect(ruleset).not.toContain('ip saddr 10.20.20.0/24');
		expect(ruleset).not.toContain('iifname { "wg0" } oifname != { "wg0" } drop');
	});

	it('accepts a governed client leaving the vpn entirely, after every grant', () => {
		const ruleset = buildRuleset([
			graphOf({
				isExitNode: true,
				tags: ['office'],
				peers: [{ id: 'p1', ip: '10.20.20.2', tags: ['office'], exitViaServer: true }],
				grants: [{ action: 'deny', srcTag: 'office', dst: 'any' }],
			}),
		]);

		const fwd = ruleset.match(/chain fwd_s0 \{([\s\S]*?)\n\t\}/)![1];
		// an admin deny placed above still wins - the accept only exists so a *governed* client
		// isn't caught by the default-deny
		expect(fwd.indexOf('ip saddr @s0t0 drop')).toBeLessThan(fwd.indexOf('@s0_serverexit'));
		expect(ruleset).toContain('ip saddr @s0_serverexit oifname != { "wg0" } accept comment "exit via this server"');
	});

	it('emits nothing at all while the server does not offer its uplink', () => {
		// A stale exitViaServer on a peer whose server has since turned the exit off must not
		// keep masquerading that peer.
		const ruleset = buildRuleset([graphOf({ isExitNode: false, peers: [{ id: 'p1', ip: '10.20.20.2', exitViaServer: true }] })]);

		expect(ruleset).not.toContain('serverexit');
		expect(ruleset).not.toContain('masquerade');
		expect(ruleset).not.toContain('chain postrouting');
	});

	it('counts every managed interface as "still inside the vpn", exit links included', () => {
		// oifname != <managed> is what "leaving the vpn" means; an exit link is not leaving it.
		const ruleset = buildRuleset([
			graphOf({
				isExitNode: true,
				peers: [
					{ id: 'gw', ip: '10.20.20.9', isExitNode: true, link: { interfaceName: 'wgx0', listenPort: 51900, routeTableId: 52000 } },
					{ id: 'p1', ip: '10.20.20.2', exitViaServer: true },
				],
			}),
		]);

		expect(ruleset).toContain('ip saddr @s0_serverexit oifname != { "wg0", "wgx0" } masquerade');
	});
});
