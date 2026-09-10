import { db } from '@server/db';
import { serverPeersTable } from '@server/db/schema';
import { createLog } from '@server/lib/log';
import { asc } from 'drizzle-orm';
import { applyFirewall } from './shell';
import { loadPolicyGraph, type PolicyGraph } from '@server/db/policyGraph';

const log = createLog('wg:firewall');

// A peer can carry many tags (peerTagAssignmentsTable) and policy is an explicit, ordered list
// of grants (policyGrantsTable) - each `action` (allow/deny) fires on the first grant whose
// src/dst/protocol/ports match. A peer is "governed" the moment it carries >=1 tag or is named
// directly as a grant's src peer; a governed peer with no matching grant is denied by default
// (tagging alone is enough to lock a peer down). A peer that is neither is ungoverned and falls
// through untouched - unrestricted, exactly like the old `groupId = null` behaviour. This is what
// makes "policy on the individual client" take precedence over tag-level policy: a peer-scoped
// grant placed above the tag-scoped ones in the ordered list wins.
export type FirewallTag = {
	id: string;
	name: string;
	memberIps: string[];
};

export type FirewallGrant = {
	action: 'allow' | 'deny';
	src: { kind: 'tag'; tagId: string } | { kind: 'peer'; ip: string };
	dst: { kind: 'tag'; tagId: string } | { kind: 'peer'; ip: string } | { kind: 'cidr'; cidr: string } | { kind: 'server' } | { kind: 'internet' } | { kind: 'any' };
	protocol: 'any' | 'tcp' | 'udp' | 'icmp';
	ports: string | null;
	comment: string | null;
};

export type FirewallServer = {
	interfaceName: string;
	cidrRange: string;
	wgAddress: string;
	enableNat: boolean;
	tags: FirewallTag[];
	// already in evaluation order (ascending `position`, enabled only) - see loadFirewallState
	grants: FirewallGrant[];
	// ips of peers that must be default-denied once nothing in `grants` matches - see the
	// "governed" note above. Anyone not in this set falls through to `return`, unrestricted.
	governedIps: string[];
	// ips of peers whose `exitPeerId` names this server's exit node (wg/exitRouting.ts).
	// Their internet-bound traffic leaves *via* this wg interface (to the exit node) rather
	// than via a non-wg one, so it matches neither an `internet`-dst grant (compiled to
	// `oifname != <managed>`) nor the base chain's egress guard - it needs the explicit
	// accept emitted at the bottom of `fwd_s{i}` below. Deliberately *not* folded into
	// governedIps: assigning an exit node must not change whether a peer is governed.
	exitClientIps: string[];
	// the exit node's own ip, or null - the accept below has to exclude traffic aimed at the
	// tunnel itself, which is ordinary peer-to-peer traffic and governed by grants as usual
	exitPeerIp: string | null;
};

// nft identifiers must start with a letter and only accept a limited charset. nanoid
// ids and interfaceName (validated only by /^[a-zA-Z0-9_=+.-]{1,15}$/, which admits
// `=` and `+`) don't satisfy that, so objects are named by stable ordinal position
// instead - the human name still appears as an nft `comment` for readability.
const sanitizeComment = (value: string) => value.replace(/[\\"\r\n]/g, '').slice(0, 64);

// This feature is ipv4-only throughout (see the `meta nfproto ipv6 drop` in buildRuleset).
// `ip daddr <cidr>` is the ipv4-specific match - handing it an ipv6 literal is an
// nft type error (`nft -f` exits 1: "Address family for hostname not supported"),
// not something nft just ignores. Used both to gate the api (`policy.ts`) and,
// defensively, here - a dstCidr already in the db (e.g. from before this check
// existed) must not be able to permanently break every future sync.
export const isIpv4Cidr = (value: string) => /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[1-2][0-9]|3[0-2])$/.test(value);

const quote = (value: string) => `"${value}"`;

/**
 * Pure ruleset builder - no db, no io. Takes an explicit, ordered list of servers
 * (ordinal position determines the generated nft names, so callers must pass a
 * stable order) and returns the full `table inet wgmgr` nft script as text.
 */
export const buildRuleset = (servers: FirewallServer[]): string => {
	const allInterfaces = [...new Set(servers.map((s) => s.interfaceName))];
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
			case 'internet':
				return `oifname != ${managedIfaceSet}`;
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
	const forwardLines: string[] = [];
	const inputLines: string[] = [];
	const fwdChains: string[] = [];
	const srcChains: string[] = [];
	const inChains: string[] = [];
	const natLines: string[] = [];

	servers.forEach((server, i) => {
		// Nothing to enforce: no policy at all and no exit clients to allow through. Emitting
		// no chain for this server is what keeps a deployment that never touched either
		// feature byte-identical to before.
		if (server.tags.length === 0 && server.grants.length === 0 && server.exitClientIps.length === 0) return;

		const governedName = `s${i}_governed`;
		const fwdName = `fwd_s${i}`;
		const inName = `in_s${i}`;

		sets.push(renderSet(governedName, server.governedIps));
		const exitClientsName = `s${i}_exitclients`;
		if (server.exitClientIps.length) {
			sets.push(renderSet(exitClientsName, server.exitClientIps, 'exit node clients'));
		}
		server.tags.forEach((tag, j) => {
			sets.push(renderSet(`s${i}t${j}`, tag.memberIps, tag.name));
		});

		forwardLines.push(`\tiifname ${quote(server.interfaceName)} jump ${fwdName}`);
		inputLines.push(`\tiifname ${quote(server.interfaceName)} ip saddr @${governedName} jump ${inName}`);

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
		// this one narrow allowance at the bottom. `ip daddr != cidrRange` keeps it to
		// internet-bound traffic - reaching other peers on this interface stays entirely a
		// matter of grants. Without this, a *governed* exit client would be dropped by the
		// default-deny below and its exit node would silently do nothing.
		if (server.exitClientIps.length && server.exitPeerIp) {
			fwdBody.push(`\tip saddr @${exitClientsName} oifname ${quote(server.interfaceName)} ip daddr != ${server.cidrRange} accept comment ${quote('exit node')}`);
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

		if (server.enableNat) {
			natLines.push(`\tip saddr ${server.cidrRange} oifname != ${managedIfaceSet} masquerade`);
		}
	});

	const parts: string[] = [];

	parts.push(...sets);

	// Safety net: an ungoverned peer falls through `fwd_s{i}`'s `return` (it's
	// unrestricted, matching today's behaviour) and would otherwise hit this base
	// chain's `policy accept` even for traffic leaving via a non-wg interface - i.e.
	// internet/LAN egress, only reachable at all once postrouting can masquerade it
	// (`enableNat`). That capability is new and must stay opt-in per peer/tag, so
	// explicitly deny it for any wg-sourced traffic not already accepted by a
	// grant. Only added when some server has NAT on - with NAT off
	// everywhere (the default) such traffic already can't work (no route back), so
	// this stays a true no-op for every deployment that hasn't touched the feature.
	// Peer-to-peer reachability (iif == oif, both managed wg interfaces) is untouched.
	const egressGuard = allInterfaces.length && servers.some((s) => s.enableNat) ? [`\tiifname ${managedIfaceSet} oifname != ${managedIfaceSet} drop`] : [];

	parts.push(
		[
			`chain forward {`,
			`\ttype filter hook forward priority filter; policy accept;`,
			`\tct state invalid drop`,
			`\tct state established,related accept`,
			...forwardLines,
			...egressGuard,
			`}`,
		].join('\n')
	);

	parts.push(...fwdChains);
	parts.push(...srcChains);

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

// Builds this server's FirewallServer from its policy graph (see db/policyGraph.ts) -
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
		} else if (grant.dstKind === 'internet') {
			dst = { kind: 'internet' };
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

	// At most one exit node per server (only one peer can own AllowedIPs 0.0.0.0/0 on a wg
	// interface) - api-enforced; pick deterministically if a direct db write broke that.
	const exitPeer = graph.peers.filter((p) => p.isExitNode).sort((a, b) => a.id.localeCompare(b.id))[0];

	return {
		interfaceName: graph.server.interfaceName,
		cidrRange: graph.server.cidrRange,
		wgAddress: graph.server.wgAddress,
		enableNat: graph.server.enableNat,
		tags: firewallTags,
		grants: firewallGrants,
		governedIps: [...governedPeerIds].map((id) => peerIp.get(id)).filter((ip): ip is string => Boolean(ip)),
		exitClientIps: exitPeer ? graph.peers.filter((p) => p.exitPeerId === exitPeer.id && p.id !== exitPeer.id).map((p) => p.wgAddress) : [],
		exitPeerIp: exitPeer?.wgAddress ?? null,
	};
};

const loadFirewallState = async (): Promise<FirewallServer[]> => {
	// buildRuleset's ordinal `s{i}`/`s{i}t{j}` naming (see its doc comment) depends on a
	// stable server order - createdAt is a timestamp with second-ish resolution, so break
	// ties by id to keep the order deterministic even for servers created in the same tick.
	const servers = await db.query.serverPeersTable.findMany({ orderBy: [asc(serverPeersTable.createdAt), asc(serverPeersTable.id)] });

	const graphs = await Promise.all(servers.map((s) => loadPolicyGraph(s.id)));

	return graphs.filter((g): g is PolicyGraph => !!g).map(toFirewallServer);
};

export const generateFirewallRuleset = async () => buildRuleset(await loadFirewallState());

/**
 * Regenerates the whole ruleset (it is global across all servers) and applies it
 * atomically. A failed apply leaves the previous ruleset in place - log and move on
 * rather than tearing the table down, since a partial/failed state is worse than a
 * stale-but-consistent one.
 */
export const syncFirewall = async () => {
	try {
		const ruleset = await generateFirewallRuleset();
		await applyFirewall(ruleset);
	} catch (error) {
		log.error(`Failed to sync firewall ruleset: ${error}`);
	}
};
