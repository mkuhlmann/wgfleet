import { describe, expect, it } from 'bun:test';
import { buildRuleset, type FirewallExitNode, type FirewallGrant, type FirewallServer, type FirewallTag } from './firewall';

const tag = (overrides: Partial<FirewallTag> & Pick<FirewallTag, 'id'>): FirewallTag => ({
	name: overrides.id,
	memberIps: [],
	...overrides,
});

const grant = (overrides: Partial<FirewallGrant> & Pick<FirewallGrant, 'src' | 'dst'>): FirewallGrant => ({
	action: 'allow',
	protocol: 'any',
	ports: null,
	comment: null,
	...overrides,
});

const server = (overrides: Partial<FirewallServer> = {}): FirewallServer => ({
	interfaceName: 'wg0',
	cidrRange: '10.20.20.0/24',
	wgAddress: '10.20.20.1',
	tags: [],
	grants: [],
	governedIps: [],
	exitNodes: [],
	advertisedRoutes: [],
	...overrides,
});

// One exit node, as the ruleset sees it: its own interface, its own ip, its clients.
const exitNode = (overrides: Partial<FirewallExitNode> = {}): FirewallExitNode => ({
	interfaceName: 'wgx0',
	ip: '10.20.20.2',
	clientIps: ['10.20.20.3'],
	...overrides,
});

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
		const t = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2', '10.20.20.5'] });
		const ruleset = buildRuleset([server({ tags: [t], governedIps: t.memberIps })]);

		expect(ruleset).toContain('set s0t0 {');
		expect(ruleset).toContain('elements = { 10.20.20.2, 10.20.20.5 }');
		expect(ruleset).toContain('comment "office"');
		expect(ruleset).toContain('chain fwd_s0 {');
		// governed (tagged), no grants at all -> default-deny, not unrestricted
		expect(ruleset).toMatch(/chain fwd_s0 \{\s*\n\s*meta nfproto ipv6 drop\s*\n\s*ip saddr @s0_governed drop\s*\n\s*return\s*\n\s*\}/);
	});

	it('does not emit an elements line for an empty tag', () => {
		const empty = tag({ id: 't-empty', name: 'empty' });
		const withMembers = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2'] });
		const ruleset = buildRuleset([server({ tags: [empty, withMembers], governedIps: ['10.20.20.2'] })]);

		expect(ruleset).not.toContain('elements = {  }');
		expect(ruleset).not.toContain('elements = { }');
		expect(ruleset).toMatch(/set s0t0 \{\s*\n\s*type ipv4_addr\s*\n\s*comment "empty"\s*\n\s*\}/);
	});

	it('scopes sets and chains per-server, even with overlapping CIDRs', () => {
		const officeA = tag({ id: 'a-office', name: 'office', memberIps: ['10.0.0.2'] });
		const officeB = tag({ id: 'b-office', name: 'office', memberIps: ['10.0.0.2'] }); // same ip, different server
		const ruleset = buildRuleset([server({ interfaceName: 'wg0', cidrRange: '10.0.0.0/24', tags: [officeA], governedIps: ['10.0.0.2'] }), server({ interfaceName: 'wg1', cidrRange: '10.0.0.0/24', tags: [officeB], governedIps: ['10.0.0.2'] })]);

		expect(ruleset).toContain('iifname "wg0" jump fwd_s0');
		expect(ruleset).toContain('iifname "wg1" jump fwd_s1');
		expect(ruleset).toContain('set s0t0 {');
		expect(ruleset).toContain('set s1t0 {');
		expect(ruleset).toContain('chain fwd_s0 {');
		expect(ruleset).toContain('chain fwd_s1 {');
	});

	it('grants a directional tag -> tag rule without granting the reverse', () => {
		const dbTag = tag({ id: 't-db', name: 'db', memberIps: ['10.20.20.9'] });
		const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2'] });
		const g = grant({ src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'tag', tagId: 't-db' } });
		const ruleset = buildRuleset([server({ tags: [office, dbTag], grants: [g], governedIps: ['10.20.20.2'] })]);

		expect(ruleset).toContain('ip saddr @s0t0 ip daddr @s0t1 accept');
		// only office (s0t0) was granted db (s0t1) as a destination - the reverse
		// accept (db -> office) must not appear anywhere in the ruleset
		expect(ruleset).not.toContain('ip saddr @s0t1 ip daddr @s0t0 accept');
	});

	it('denies intra-tag traffic unless a self-referencing grant is explicitly added', () => {
		const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2', '10.20.20.3'] });
		const withoutSelfGrant = buildRuleset([server({ tags: [office], governedIps: office.memberIps })]);
		expect(withoutSelfGrant).not.toContain('ip saddr @s0t0 ip daddr @s0t0 accept');

		const selfGrant = grant({ src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'tag', tagId: 't-office' } });
		const withSelfGrant = buildRuleset([server({ tags: [office], grants: [selfGrant], governedIps: office.memberIps })]);
		expect(withSelfGrant).toContain('ip saddr @s0t0 ip daddr @s0t0 accept');
	});

	it('allows a dstCidr target', () => {
		const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2'] });
		const g = grant({ src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'cidr', cidr: '192.168.50.0/24' } });
		const ruleset = buildRuleset([server({ tags: [office], grants: [g], governedIps: office.memberIps })]);

		expect(ruleset).toContain('ip daddr 192.168.50.0/24 accept');
	});

	it('drops a grant with an ipv6 dstCidr rather than emitting an invalid `ip daddr <ipv6>` line', () => {
		// regression: `ip daddr` is the ipv4-specific match - handing it an ipv6
		// literal is an nft type error (`nft -f` exits 1), not something nft
		// tolerates. A stray ipv6 rule must not be able to break every future sync.
		const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2'] });
		const bad = grant({ src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'cidr', cidr: 'fd00::/64' } });
		const good = grant({ src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'cidr', cidr: '192.168.50.0/24' } });
		const ruleset = buildRuleset([server({ tags: [office], grants: [bad, good], governedIps: office.memberIps })]);

		expect(ruleset).not.toContain('fd00::');
		expect(ruleset).toContain('ip daddr 192.168.50.0/24 accept');
	});

	it('ignores a grant with an unresolvable tag reference rather than breaking the ruleset', () => {
		const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2'] });
		const stale = grant({ src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'tag', tagId: 't-deleted' } });
		const ruleset = buildRuleset([server({ tags: [office], grants: [stale], governedIps: office.memberIps })]);

		expect(ruleset).not.toContain('t-deleted');
		expect(ruleset).toMatch(/chain fwd_s0 \{\s*\n\s*meta nfproto ipv6 drop\s*\n\s*ip saddr @s0_governed drop\s*\n\s*return\s*\n\s*\}/);
	});

	it('routes governed traffic to the input chain only via dstKind server/any grants', () => {
		const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2'] });
		const g = grant({ src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'server' } });
		const ruleset = buildRuleset([server({ tags: [office], grants: [g], governedIps: office.memberIps })]);

		expect(ruleset).toContain('chain input {');
		expect(ruleset).toContain('iifname "wg0" ip saddr @s0_governed jump in_s0');
		expect(ruleset).toMatch(/chain in_s0 \{\s*\n\s*meta nfproto ipv6 drop\n\s*ip saddr @s0t0 accept\s*\n\s*drop\s*\n\s*\}/);
		// a server-dst grant must not also show up in the forward chain
		const fwdBody = ruleset.match(/chain fwd_s0 \{([\s\S]*?)\n\t\}/)![1];
		expect(fwdBody).not.toContain('accept');
	});

	it('drops governed traffic to the gateway by default when no server-dst grant exists', () => {
		const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2'] });
		const ruleset = buildRuleset([server({ tags: [office], governedIps: office.memberIps })]);

		expect(ruleset).toMatch(/chain in_s0 \{\s*\n\s*meta nfproto ipv6 drop\n\s*drop\s*\n\s*\}/);
	});

	it('a dstKind any grant applies to both the forward and input chains', () => {
		const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2'] });
		const g = grant({ src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'any' } });
		const ruleset = buildRuleset([server({ tags: [office], grants: [g], governedIps: office.memberIps })]);

		expect(ruleset).toMatch(/chain fwd_s0 \{[\s\S]*ip saddr @s0t0 accept/);
		expect(ruleset).toMatch(/chain in_s0 \{[\s\S]*ip saddr @s0t0 accept/);
	});

	it('evaluates grants in order, first match wins', () => {
		const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2'] });
		const db = tag({ id: 't-db', name: 'db', memberIps: ['10.20.20.9'] });
		const deny = grant({ action: 'deny', src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'tag', tagId: 't-db' } });
		const allow = grant({ action: 'allow', src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'tag', tagId: 't-db' } });
		const ruleset = buildRuleset([server({ tags: [office, db], grants: [deny, allow], governedIps: office.memberIps })]);

		const fwd = ruleset.match(/chain fwd_s0 \{([\s\S]*?)\n\t\}/)![1];
		const dropIdx = fwd.indexOf('drop');
		const acceptIdx = fwd.indexOf('accept');
		expect(dropIdx).toBeGreaterThan(-1);
		expect(acceptIdx).toBeGreaterThan(dropIdx); // the deny rule (drop) must precede the allow rule
	});

	it('lets a peer-scoped grant placed above a tag-scoped one override it (per-client precedence)', () => {
		const db = tag({ id: 't-db', name: 'db', memberIps: ['10.20.20.9'] });
		const dev = tag({ id: 't-dev', name: 'dev', memberIps: ['10.20.20.2', '10.20.20.3'] });
		const peerDeny = grant({ action: 'deny', src: { kind: 'peer', ip: '10.20.20.2' }, dst: { kind: 'tag', tagId: 't-db' } });
		const tagAllow = grant({ action: 'allow', src: { kind: 'tag', tagId: 't-dev' }, dst: { kind: 'tag', tagId: 't-db' } });
		const ruleset = buildRuleset([server({ tags: [dev, db], grants: [peerDeny, tagAllow], governedIps: ['10.20.20.2', '10.20.20.3'] })]);

		expect(ruleset).toContain('ip saddr 10.20.20.2 ip daddr @s0t1 drop');
		const fwd = ruleset.match(/chain fwd_s0 \{([\s\S]*?)\n\t\}/)![1];
		expect(fwd.indexOf('ip saddr 10.20.20.2 ip daddr @s0t1 drop')).toBeLessThan(fwd.indexOf('ip saddr @s0t0 ip daddr @s0t1 accept'));
	});

	it('renders tcp/udp port lists and ranges, and a bare protocol match with no ports', () => {
		const dev = tag({ id: 't-dev', name: 'dev', memberIps: ['10.20.20.2'] });
		const db = tag({ id: 't-db', name: 'db', memberIps: ['10.20.20.9'] });
		const withPorts = grant({ src: { kind: 'tag', tagId: 't-dev' }, dst: { kind: 'tag', tagId: 't-db' }, protocol: 'tcp', ports: '22, 8000-8100' });
		const noPorts = grant({ src: { kind: 'tag', tagId: 't-dev' }, dst: { kind: 'tag', tagId: 't-db' }, protocol: 'udp' });
		const icmp = grant({ src: { kind: 'tag', tagId: 't-dev' }, dst: { kind: 'tag', tagId: 't-db' }, protocol: 'icmp' });
		const ruleset = buildRuleset([server({ tags: [dev, db], grants: [withPorts, noPorts, icmp], governedIps: dev.memberIps })]);

		expect(ruleset).toContain('tcp dport { 22, 8000-8100 } accept');
		expect(ruleset).toContain('meta l4proto udp accept');
		expect(ruleset).toContain('meta l4proto icmp accept');
	});

	it('attaches a sanitized nft comment to a grant', () => {
		const dev = tag({ id: 't-dev', name: 'dev', memberIps: ['10.20.20.2'] });
		const db = tag({ id: 't-db', name: 'db', memberIps: ['10.20.20.9'] });
		const g = grant({ src: { kind: 'tag', tagId: 't-dev' }, dst: { kind: 'tag', tagId: 't-db' }, comment: 'db access for "dev"' });
		const ruleset = buildRuleset([server({ tags: [dev, db], grants: [g], governedIps: dev.memberIps })]);

		expect(ruleset).toContain('comment "db access for dev"');
	});

	it('never masquerades and never guards egress - the hub is not a gateway', () => {
		// Hub egress was removed (drizzle/0008_drop_hub_egress.sql): with no masquerade there
		// is no egress path to permit, deny or guard, so the ruleset carries no nat hook and no
		// oifname-based rule at all. A client reaches the internet through an exit node peer,
		// whose traffic never leaves the wg interface here.
		const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2'] });
		const g = grant({ src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'any' } });
		const ruleset = buildRuleset([server({ tags: [office], grants: [g], governedIps: office.memberIps }), server({ interfaceName: 'wg1' })]);

		expect(ruleset).not.toContain('chain postrouting');
		expect(ruleset).not.toContain('masquerade');
		expect(ruleset).not.toContain('oifname !=');
	});

	describe('exit nodes', () => {
		it("accepts an exit client's internet-bound traffic leaving via that exit node's own link", () => {
			// No destination a grant can name matches exit traffic: it leaves *via* the exit
			// link towards the exit node. Without this rule a governed exit client would be
			// dropped by the default-deny and its exit node would silently do nothing.
			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', exitNodes: [exitNode()] })]);

			expect(ruleset).toContain('elements = { 10.20.20.3 }');
			expect(ruleset).toContain('ip saddr @s0e0 oifname "wgx0" ip daddr != 10.20.20.0/24 accept');
		});

		it("pins each exit node to its own link, so a client cannot leave through somebody else's", () => {
			// Routing already guarantees this (a client's ip rule names exactly one table), but
			// a single shared accept would quietly permit any exit client down any exit link.
			const ruleset = buildRuleset([
				server({
					cidrRange: '10.20.20.0/24',
					exitNodes: [exitNode({ interfaceName: 'wgx0', ip: '10.20.20.2', clientIps: ['10.20.20.3'] }), exitNode({ interfaceName: 'wgx1', ip: '10.20.20.4', clientIps: ['10.20.20.5'] })],
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
			const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.2'] });
			const ruleset = buildRuleset([server({ tags: [office], governedIps: office.memberIps, exitNodes: [exitNode()] })]);

			expect(ruleset).toContain('iifname "wg0" jump fwd_s0');
			expect(ruleset).toContain('iifname "wgx0" jump fwd_s0');
			expect(ruleset).toContain('iifname "wgx0" ip saddr @s0_governed jump in_s0');
		});

		it('scopes the accept to internet-bound traffic, leaving peer-to-peer entirely to grants', () => {
			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', exitNodes: [exitNode()] })]);

			// `ip daddr != cidrRange` is what keeps it from being a blanket allow within the vpn
			expect(ruleset).toContain('ip daddr != 10.20.20.0/24');
		});

		it('places the exit accept after every explicit grant, so a deny above it still wins', () => {
			const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.3'] });
			const denyAll = grant({ action: 'deny', src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'any' } });
			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', tags: [office], grants: [denyAll], governedIps: office.memberIps, exitNodes: [exitNode()] })]);

			const denyAt = ruleset.indexOf('ip saddr @s0t0 drop');
			const exitAt = ruleset.indexOf('@s0e0');

			expect(denyAt).toBeGreaterThanOrEqual(0);
			expect(exitAt).toBeGreaterThan(denyAt);
		});

		it('emits the exit chain even for a server with no tags and no grants', () => {
			// the exit-client accept is the only policy such a server has - skipping the
			// chain (as an entirely policy-free server does) would drop it with the chain
			const ruleset = buildRuleset([server({ exitNodes: [exitNode()] })]);

			expect(ruleset).toContain('chain fwd_s0 {');
		});

		it('emits nothing for an exit node with no clients assigned', () => {
			const ruleset = buildRuleset([server({ exitNodes: [exitNode({ clientIps: [] })] })]);

			expect(ruleset).not.toContain('s0e0');
			expect(ruleset).not.toContain('chain fwd_s0 {');
		});

		it('keeps exit clients out of the governed set, so assigning an exit node does not lock a peer down', () => {
			const ruleset = buildRuleset([server({ exitNodes: [exitNode()] })]);

			// s0_governed is emitted but empty - an exit client with no tags stays ungoverned
			expect(ruleset).toContain('set s0_governed {');
			expect(ruleset).not.toContain('set s0_governed {\n\t\ttype ipv4_addr\n\t\telements');
		});

		it('omits the exit accept for an exit node whose link is not provisioned yet', () => {
			// toFirewallServer drops a link-less exit node, so it reaches buildRuleset as no exit
			// node at all - the same state the config and routing layers see it in.
			const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.3'] });
			const ruleset = buildRuleset([server({ tags: [office], governedIps: office.memberIps, exitNodes: [] })]);

			const fwdBody = ruleset.match(/chain fwd_s0 \{([\s\S]*?)\n\t\}/)![1];
			expect(fwdBody).not.toContain('accept');
		});
	});

	describe('advertised subnet routes', () => {
		it('needs no rule of its own - a cidr-dst grant already compiles to the accept', () => {
			const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.3'] });
			const toLan = grant({ src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'cidr', cidr: '192.168.1.0/24' } });
			const ruleset = buildRuleset([server({ tags: [office], grants: [toLan], governedIps: office.memberIps, advertisedRoutes: ['192.168.1.0/24'] })]);

			expect(ruleset).toContain('ip saddr @s0t0 ip daddr 192.168.1.0/24 accept');
		});

		it('changes nothing at all on an interface with no exit clients', () => {
			// the column is invisible to the firewall except through the exit accept below
			const withRoutes = buildRuleset([server({ tags: [tag({ id: 't-office', memberIps: ['10.20.20.3'] })], advertisedRoutes: ['192.168.1.0/24'] })]);
			const without = buildRuleset([server({ tags: [tag({ id: 't-office', memberIps: ['10.20.20.3'] })] })]);

			expect(withRoutes).toBe(without);
		});

		it('excludes an advertised LAN from the exit accept, so reaching it still needs a grant', () => {
			// Without this, a governed exit client would reach every advertised LAN on the
			// interface for free: that traffic leaves via the same wg interface and is neither
			// inside cidrRange nor matched by an `internet`-dst grant. Advertising deliberately
			// adds no permission mechanism, so the grants list has to stay the only way in.
			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', exitNodes: [exitNode()], advertisedRoutes: ['192.168.1.0/24'] })]);

			expect(ruleset).toContain('ip saddr @s0e0 oifname "wgx0" ip daddr != { 10.20.20.0/24, 192.168.1.0/24 } accept');
		});

		it('keeps the single-prefix form when nothing is advertised', () => {
			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', exitNodes: [exitNode()] })]);

			expect(ruleset).toContain('ip daddr != 10.20.20.0/24 accept');
		});

		it('a grant above the exit accept still lets an exit client reach an advertised LAN', () => {
			const office = tag({ id: 't-office', name: 'office', memberIps: ['10.20.20.3'] });
			const toLan = grant({ src: { kind: 'tag', tagId: 't-office' }, dst: { kind: 'cidr', cidr: '192.168.1.0/24' } });
			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', tags: [office], grants: [toLan], governedIps: office.memberIps, exitNodes: [exitNode()], advertisedRoutes: ['192.168.1.0/24'] })]);

			const grantAt = ruleset.indexOf('ip daddr 192.168.1.0/24 accept');
			const exitAt = ruleset.indexOf('@s0e0');

			expect(grantAt).toBeGreaterThanOrEqual(0);
			expect(grantAt).toBeLessThan(exitAt);
		});

		it('ignores a non-ipv4 advertised prefix rather than emitting an nft type error', () => {
			const ruleset = buildRuleset([server({ cidrRange: '10.20.20.0/24', exitNodes: [exitNode()], advertisedRoutes: ['fd00::/64'] })]);

			expect(ruleset).toContain('ip daddr != 10.20.20.0/24 accept');
			expect(ruleset).not.toContain('fd00');
		});
	});
});
