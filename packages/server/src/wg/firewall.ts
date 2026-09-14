import { createLog } from '@server/lib/log';
import { exitTopology, type PolicyGraph } from '@server/db/policyGraph';
// Applied defensively here as well as at the api (lib/grantInvariants.ts): a dstCidr already in
// the db - from before that check existed - must not be able to break every future sync.
import { isIpv4Cidr } from '@server/lib/validation';

const log = createLog('wg:firewall');

// A peer can carry many tags (peerTagAssignmentsTable) and policy is an explicit, ordered list
// of grants (policyGrantsTable) - each `action` (allow/deny) fires on the first grant whose
// src/dst/protocol/ports match. A peer is "governed" the moment it carries >=1 tag or is named
// directly as a grant's src peer; a governed peer with no matching grant is denied by default
// (tagging alone is enough to lock a peer down). A peer that is neither is ungoverned and falls
// through untouched - unrestricted, exactly like the old `groupId = null` behaviour. This is what
// makes "policy on the individual client" take precedence over tag-level policy: a peer-scoped
// grant placed above the tag-scoped ones in the ordered list wins.
type FirewallTag = {
	id: string;
	name: string;
	memberIps: string[];
};

type FirewallGrant = {
	action: 'allow' | 'deny';
	src: { kind: 'tag'; tagId: string } | { kind: 'peer'; ip: string };
	dst: { kind: 'tag'; tagId: string } | { kind: 'peer'; ip: string } | { kind: 'cidr'; cidr: string } | { kind: 'server' } | { kind: 'any' };
	protocol: 'any' | 'tcp' | 'udp' | 'icmp';
	ports: string | null;
	comment: string | null;
};

/**
 * One exit node, from the ruleset's point of view: the interface its traffic leaves through and
 * the clients allowed down it. One per exit node rather than one per server, because that is
 * how many interfaces there are - see wg/exitLinks.ts.
 */
type FirewallExitNode = {
	/** the exit link's interface name - the `oifname` exit traffic leaves through */
	interfaceName: string;
	/** the exit node's own ip. Traffic *to* it is ordinary peer traffic, governed by grants. */
	ip: string;
	/**
	 * ips of the peers whose `exitPeerId` names this exit node. Their internet-bound traffic
	 * leaves via this exit link, so no destination a grant can name matches it - `any` and
	 * `server` are about the hub itself, and everything else is a prefix inside the vpn. It
	 * needs the explicit accept emitted at the bottom of `fwd_s{i}`. Deliberately *not* folded
	 * into governedIps: assigning an exit node must not change whether a peer is governed.
	 */
	clientIps: string[];
};

type FirewallServer = {
	interfaceName: string;
	cidrRange: string;
	tags: FirewallTag[];
	// already in evaluation order (ascending `position`, enabled only) - see toFirewallServer
	grants: FirewallGrant[];
	// ips of peers that must be default-denied once nothing in `grants` matches - see the
	// "governed" note above. Anyone not in this set falls through to `return`, unrestricted.
	governedIps: string[];
	// this server's exit nodes, in the order lib/exitTopology.ts produces (the nft set names
	// below are ordinal). Any number of them - each has its own interface.
	exitNodes: FirewallExitNode[];
	/**
	 * ips of the peers exiting through this *server's* own uplink (`peers.exitViaServer`). They
	 * are the only traffic this manager ever masquerades, and the masquerade is scoped to exactly
	 * this set - which is what keeps "turning the server's exit on" from handing the internet to
	 * every other peer as a side effect, without needing a separate guard rule to take it back.
	 */
	serverExitClientIps: string[];
	// every subnet route advertised by a peer on this server (`peers.advertisedRoutes`),
	// wherever that peer lives.
	// Advertising needs no rule of its own - a `dstKind: 'cidr'` grant already compiles to
	// `ip daddr <cidr> accept`, and replies from the LAN are `ct state established,related`.
	// It appears here only to be *excluded* from the exit-clients accept below: an advertised
	// LAN leaves via this same wg interface, so without the exclusion an exit client would
	// reach every advertised LAN without a grant, quietly contradicting the rule that grants
	// alone decide who reaches a cidr.
	advertisedRoutes: string[];
};

// nft identifiers must start with a letter and only accept a limited charset. nanoid
// ids and interfaceName (validated only by /^[a-zA-Z0-9_=+.-]{1,15}$/, which admits
// `=` and `+`) don't satisfy that, so objects are named by stable ordinal position
// instead - the human name still appears as an nft `comment` for readability.
const sanitizeComment = (value: string) => value.replace(/[\\"\r\n]/g, '').slice(0, 64);

const quote = (value: string) => `"${value}"`;

// `ip daddr != x` for one prefix, `ip daddr != { x, y }` for several - nft accepts a negated
// anonymous set but not a single-element brace list in every version, and the bare form keeps
// the ruleset byte-identical for an interface with no advertised routes.
// Returns undefined when nothing is left to exclude, which can only happen if a directly
// written cidrRange isn't ipv4 - the caller then drops the rule rather than emitting an empty
// set literal that would fail the whole `nft -f` and leave the previous ruleset in place.
const renderExcluded = (cidrs: string[]): string | undefined => {
	const unique = [...new Set(cidrs.filter(isIpv4Cidr))].sort();
	if (unique.length === 0) return undefined;
	return unique.length === 1 ? unique[0] : `{ ${unique.join(', ')} }`;
};

/**
 * Emits the nft script from the projection below. Internal: the module's interface is
 * buildRuleset(fleet), so that the projection and the emission are tested as one thing - see
 * the note there.
 */
const emitRuleset = (servers: FirewallServer[]): string => {
	// Every wg interface this manager owns. `oifname != <these>` is how a rule says "leaving the
	// vpn entirely", which is the one thing exiting via a server's own uplink does and nothing
	// else here does.
	const allInterfaces = [...new Set(servers.flatMap((s) => [s.interfaceName, ...s.exitNodes.map((node) => node.interfaceName)]))];
	const managedIfaceSet = allInterfaces.length ? `{ ${allInterfaces.map(quote).join(', ')} }` : '{}';

	// resolve a tag's db id -> its ordinal `s{i}t{j}` name, across all servers (grants are
	// api-validated to never cross servers, but this stays robust to a stale cross-server id)
	const tagSetName = new Map<string, string>();
	servers.forEach((server, i) => {
		server.tags.forEach((tag, j) => {
			tagSetName.set(tag.id, `s${i}t${j}`);
		});
	});

	const renderSrc = (src: FirewallGrant['src']): string | undefined => {
		if (src.kind === 'tag') {
			const set = tagSetName.get(src.tagId);
			return set ? `ip saddr @${set}` : undefined;
		}
		return src.ip ? `ip saddr ${src.ip}` : undefined;
	};

	// `null` = valid, no dst clause needed (the destination is implicit in the chain the rule
	// ends up in - see below). `undefined` = unresolvable, the whole grant must be skipped
	// (stale tag/peer reference, or a non-ipv4 cidr - see isIpv4Cidr comment above).
	const renderDst = (dst: FirewallGrant['dst']): string | null | undefined => {
		switch (dst.kind) {
			case 'tag': {
				const set = tagSetName.get(dst.tagId);
				return set ? `ip daddr @${set}` : undefined;
			}
			case 'peer':
				return dst.ip ? `ip daddr ${dst.ip}` : undefined;
			case 'cidr':
				return isIpv4Cidr(dst.cidr) ? `ip daddr ${dst.cidr}` : undefined;
			case 'server':
			case 'any':
				return null;
		}
	};

	const renderL4 = (protocol: FirewallGrant['protocol'], ports: string | null): string | undefined => {
		if (protocol === 'any') return undefined;
		if (protocol === 'icmp') return 'meta l4proto icmp';
		if (ports && ports.trim()) {
			const normalized = ports
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean)
				.join(', ');
			return `${protocol} dport { ${normalized} }`;
		}
		return `meta l4proto ${protocol}`;
	};

	const renderGrantRule = (grant: FirewallGrant): string | undefined => {
		const src = renderSrc(grant.src);
		if (!src) return undefined;
		const dst = renderDst(grant.dst);
		if (dst === undefined) return undefined;
		const l4 = renderL4(grant.protocol, grant.ports);
		const verdict = grant.action === 'allow' ? 'accept' : 'drop';
		const clause = [src, dst, l4, verdict].filter((p): p is string => Boolean(p)).join(' ');
		const comment = grant.comment ? ` comment ${quote(sanitizeComment(grant.comment))}` : '';
		return `\t${clause}${comment}`;
	};

	const sets: string[] = [];
	const natLines: string[] = [];
	const forwardLines: string[] = [];
	const inputLines: string[] = [];
	const fwdChains: string[] = [];
	const inChains: string[] = [];

	servers.forEach((server, i) => {
		const withClients = server.exitNodes.filter((node) => node.clientIps.length > 0);

		// Nothing to enforce: no policy at all and no exit clients to allow through. Emitting
		// no chain for this server is what keeps a deployment that never touched either
		// feature byte-identical to before.
		if (server.tags.length === 0 && server.grants.length === 0 && withClients.length === 0 && server.serverExitClientIps.length === 0) return;

		const governedName = `s${i}_governed`;
		const fwdName = `fwd_s${i}`;
		const inName = `in_s${i}`;

		sets.push(renderSet(governedName, server.governedIps));
		withClients.forEach((node, k) => {
			sets.push(renderSet(`s${i}e${k}`, node.clientIps, `clients of exit node ${node.ip}`));
		});
		const serverExitName = `s${i}_serverexit`;
		if (server.serverExitClientIps.length) {
			sets.push(renderSet(serverExitName, server.serverExitClientIps, 'clients exiting via this server'));
		}
		server.tags.forEach((tag, j) => {
			sets.push(renderSet(`s${i}t${j}`, tag.memberIps, tag.name));
		});

		// Every interface this server owns jumps into the same chain: its own, plus one per exit
		// node. An exit node is a peer of this server that happens to live on an interface of its
		// own, so its traffic has to face exactly the same policy - without these lines a tagged
		// exit node would silently become unrestricted the moment it got its own link.
		const ifaces = [server.interfaceName, ...server.exitNodes.map((node) => node.interfaceName)];
		for (const iface of ifaces) {
			forwardLines.push(`\tiifname ${quote(iface)} jump ${fwdName}`);
			inputLines.push(`\tiifname ${quote(iface)} ip saddr @${governedName} jump ${inName}`);
		}

		// ipv4-only feature (matches the rest of the codebase - the cidrRange
		// regex is ipv4-only and peers have no v6 address) - drop v6 explicitly
		// rather than silently falling through unfiltered.
		const fwdBody: string[] = [`\tmeta nfproto ipv6 drop`];
		for (const grant of server.grants) {
			// 'server'-dst grants only ever apply to traffic hitting the gateway itself,
			// handled below in the input chain, not here.
			if (grant.dst.kind === 'server') continue;
			const line = renderGrantRule(grant);
			if (line) fwdBody.push(line);
		}
		// Deliberately *after* every explicit grant: an admin's `deny` placed above still wins,
		// so the ordered grants list keeps its authority and peers.exitPeerId only ever adds
		// these narrow allowances at the bottom. `ip daddr !=` keeps each one to internet-bound
		// traffic - reaching other peers, or a LAN one of them advertises, stays entirely a
		// matter of grants. Without this, a *governed* exit client would be dropped by the
		// default-deny below and its exit node would silently do nothing.
		//
		// One rule per exit node, each pinned to that node's own interface: a client may only
		// leave through the exit node it was assigned to. Routing already guarantees that (its
		// `ip rule` names one table), so this is defence in depth rather than the boundary - but
		// a single shared rule would quietly permit any exit client down any exit link the day
		// something else puts a packet there.
		const notLocal = renderExcluded([server.cidrRange, ...server.advertisedRoutes]);
		if (notLocal) {
			withClients.forEach((node, k) => {
				fwdBody.push(`\tip saddr @s${i}e${k} oifname ${quote(node.interfaceName)} ip daddr != ${notLocal} accept comment ${quote(`exit node ${node.ip}`)}`);
			});
		}

		// Exiting via the server's own uplink is the mirror image: it leaves the vpn entirely
		// rather than heading for another interface of it, so `oifname !=` rather than `oifname`.
		// Same placement and same reason - after every grant, so an admin `deny` still wins, and
		// present at all only so a *governed* client isn't dropped by the default-deny below.
		if (server.serverExitClientIps.length) {
			fwdBody.push(`\tip saddr @${serverExitName} oifname != ${managedIfaceSet} accept comment ${quote('exit via this server')}`);
		}
		fwdBody.push(`\tip saddr @${governedName} drop`); // governed, nothing matched -> default deny
		fwdBody.push(`\treturn`); // ungoverned -> unrestricted, as before
		fwdChains.push(`chain ${fwdName} {\n${fwdBody.join('\n')}\n}`);

		// only entered for governed peers (see the jump condition above) - a 'server' or 'any'
		// dst grant applies here; everything else is meaningless against the gateway itself.
		const inBody: string[] = [`\tmeta nfproto ipv6 drop`];
		for (const grant of server.grants) {
			if (grant.dst.kind !== 'server' && grant.dst.kind !== 'any') continue;
			const line = renderGrantRule(grant);
			if (line) inBody.push(line);
		}
		inBody.push(`\tdrop`);
		inChains.push(`chain ${inName} {\n${inBody.join('\n')}\n}`);

		// The only masquerade this manager emits, and the only reason a nat hook exists at all.
		// Scoped to the selected clients rather than to `cidrRange`, so enabling the server's exit
		// gives the internet to exactly the peers that asked for it and to nobody else.
		if (server.serverExitClientIps.length) {
			natLines.push(`\tip saddr @${serverExitName} oifname != ${managedIfaceSet} masquerade`);
		}
	});

	const parts: string[] = [];

	parts.push(...sets);

	// No egress guard. The only traffic this manager masquerades is the postrouting rule below,
	// and that is scoped to exactly the clients that selected their server as their exit - so a
	// wg packet routed out a non-wg interface by anyone else still leaves with its vpn source
	// address and nothing can route the reply back. Scoping the masquerade *is* the guard, which
	// is why there is no second rule taking back what a broad one would have granted.
	parts.push([`chain forward {`, `\ttype filter hook forward priority filter; policy accept;`, `\tct state invalid drop`, `\tct state established,related accept`, ...forwardLines, `}`].join('\n'));

	parts.push(...fwdChains);

	if (inputLines.length) {
		parts.push([`chain input {`, `\ttype filter hook input priority filter; policy accept;`, `\tct state established,related accept`, ...inputLines, `}`].join('\n'));
		parts.push(...inChains);
	}

	if (natLines.length) {
		parts.push([`chain postrouting {`, `\ttype nat hook postrouting priority srcnat; policy accept;`, ...natLines, `}`].join('\n'));
	}

	const body = parts.map((p) => indent(p)).join('\n\n');

	return `table inet wgmgr {}\ndelete table inet wgmgr\ntable inet wgmgr {\n${body}\n}\n`;
};

const renderSet = (name: string, ips: string[], comment?: string) => {
	const lines = [`set ${name} {`, `\ttype ipv4_addr`];
	if (comment) lines.push(`\tcomment ${quote(sanitizeComment(comment))}`);
	if (ips.length) lines.push(`\telements = { ${ips.join(', ')} }`);
	lines.push(`}`);
	return lines.join('\n');
};

const indent = (block: string) =>
	block
		.split('\n')
		.map((line) => (line ? '\t' + line : line))
		.join('\n');

// Builds this server's projection from its policy graph (see db/policyGraph.ts) -
// resolves tag/peer references to ips, drops anything unresolvable (stale assignment, a
// grant naming a deleted tag/peer, a non-ipv4 dstCidr) rather than letting it break the
// whole ruleset, and derives `governedIps` per the "governed" rule documented on
// FirewallServer above.
const toFirewallServer = (graph: PolicyGraph): FirewallServer => {
	const peerIp = new Map(graph.peers.map((p) => [p.id, p.wgAddress]));

	const peerIdsByTag = new Map<string, string[]>();
	for (const a of graph.assignments) {
		const list = peerIdsByTag.get(a.tagId) ?? [];
		list.push(a.peerId);
		peerIdsByTag.set(a.tagId, list);
	}

	const governedPeerIds = new Set<string>();
	const firewallTags: FirewallTag[] = graph.tags.map((tag) => {
		const memberIps: string[] = [];
		for (const peerId of peerIdsByTag.get(tag.id) ?? []) {
			const ip = peerIp.get(peerId);
			if (!ip) continue; // stale assignment (peer deleted) - be defensive, ignore it
			memberIps.push(ip);
			governedPeerIds.add(peerId);
		}
		return { id: tag.id, name: tag.friendlyName ?? tag.name, memberIps };
	});

	const firewallGrants: FirewallGrant[] = [];
	for (const grant of graph.grants) {
		if (!grant.enabled) continue;

		let src: FirewallGrant['src'] | undefined;
		if (grant.srcKind === 'tag' && grant.srcTagId) {
			src = { kind: 'tag', tagId: grant.srcTagId };
		} else if (grant.srcKind === 'peer' && grant.srcPeerId) {
			const ip = peerIp.get(grant.srcPeerId);
			if (ip) {
				src = { kind: 'peer', ip };
				governedPeerIds.add(grant.srcPeerId);
			}
		}
		if (!src) {
			log.warn(`Grant ${grant.id} on server ${graph.server.id} has an unresolvable source - ignoring it. Remove and re-add the grant via the api/ui to clean it up.`);
			continue;
		}

		let dst: FirewallGrant['dst'] | undefined;
		if (grant.dstKind === 'tag' && grant.dstTagId) {
			dst = { kind: 'tag', tagId: grant.dstTagId };
		} else if (grant.dstKind === 'peer' && grant.dstPeerId) {
			const ip = peerIp.get(grant.dstPeerId);
			if (ip) dst = { kind: 'peer', ip };
		} else if (grant.dstKind === 'cidr' && grant.dstCidr) {
			dst = { kind: 'cidr', cidr: grant.dstCidr };
		} else if (grant.dstKind === 'server') {
			dst = { kind: 'server' };
		} else if (grant.dstKind === 'any') {
			dst = { kind: 'any' };
		}
		if (!dst) {
			log.warn(`Grant ${grant.id} on server ${graph.server.id} has an unresolvable destination - ignoring it. Remove and re-add the grant via the api/ui to clean it up.`);
			continue;
		}
		if (dst.kind === 'cidr' && !isIpv4Cidr(dst.cidr)) {
			log.warn(`Grant ${grant.id} on server ${graph.server.id} has a non-ipv4 dstCidr "${dst.cidr}" - ignoring it. Remove and re-add the grant via the api/ui to clean it up.`);
			continue;
		}

		firewallGrants.push({ action: grant.action, src, dst, protocol: grant.protocol, ports: grant.ports, comment: grant.comment });
	}

	// Same derivation the configs and the host's policy routing use - see lib/exitTopology.ts.
	const topology = exitTopology(graph);

	return {
		interfaceName: graph.server.interfaceName,
		cidrRange: graph.server.cidrRange,
		tags: firewallTags,
		grants: firewallGrants,
		governedIps: [...governedPeerIds].map((id) => peerIp.get(id)).filter((ip): ip is string => Boolean(ip)),
		// An exit node with no provisioned link has no interface to name, so it contributes no
		// rule - matching the config and routing layers, which also skip it.
		exitNodes: topology.exitNodes.flatMap((node) => (node.link ? [{ interfaceName: node.link.interfaceName, ip: node.ip, clientIps: node.clientIps }] : [])),
		// Only meaningful while the server actually offers its uplink: a stale column on a peer
		// whose server has since turned it off must not keep masquerading that peer.
		serverExitClientIps: graph.server.isExitNode ? topology.serverExitClientIps : [],
		advertisedRoutes: topology.allAdvertisedRoutes,
	};
};

/**
 * The whole `table inet wgmgr` script for a fleet snapshot (db/fleet.ts). Pure - no db, no io.
 *
 * This takes the snapshot rather than a pre-resolved projection on purpose. The projection
 * above is where the interesting decisions live - which peers are governed, which grants are
 * dropped as unresolvable, which exit node has no link yet - and while it sat above this
 * function's seam, every one of those decisions was re-enacted by hand in the fixtures and
 * verified by nothing. One interface, one test surface.
 *
 * The ordinal nft naming (`s{i}`, `s{i}t{j}`) depends on the snapshot's order, which is what
 * loadFleet() guarantees.
 */
export const buildRuleset = (fleet: PolicyGraph[]): string => emitRuleset(fleet.map(toFirewallServer));
