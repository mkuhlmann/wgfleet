# Server

Manages WireGuard servers and their peers: identity/keys, address assignment, firewall policy, and traffic accounting.

## Language

**Peer Address Resolution**:
Deciding the wgAddress a peer gets - either validating a caller-requested address against the server's CIDR range and its other peers, or auto-allocating the next free one starting from the server's reserved-IPs offset.
_Avoid_: IP allocation (too generic - this is always scoped to one server's peers)

**Exit Node**:
A peer that lends its own internet uplink to the other clients of its server (`peers.isExitNode`). It stays an entirely ordinary peer as far as anything else is concerned - reachable, and reaching others - but it does not live on its server's wg interface: it is the single peer of an **exit link** of its own, where it owns `AllowedIPs = 0.0.0.0/0` uncontested. Any number per server.
_Avoid_: gateway (ambiguous - it is the gateway for its own clients, but so is the hub for peer-to-peer traffic), relay (implies it forwards vpn traffic, which is the hub's job)

**Exit Client**:
A peer whose `exitPeerId` names an exit node, meaning its internet-bound traffic is policy-routed into that node's tunnel. The column is both the permission and the routing instruction: without it no `ip rule` exists, so the peer has no route to any exit node and cannot reach one by editing its own config.
_Avoid_: "peer with internet access" (there is no other kind - hub egress was removed in `drizzle/0008_drop_hub_egress.sql`, so an exit client is the only peer that reaches the internet at all)

**Exit Link**:
The wg interface a single exit node has to itself on the hub (`peers.exitInterfaceName`, `wgx0`/`wgx1`/…), with its own keypair, UDP port and policy-routing table. Exists because wireguard picks the destination peer from the packet's destination address alone, so `0.0.0.0/0` has one owner per interface - an interface each removes the collision instead of rationing it. Allocated and released by `reconcileExitLinks` on converge, never by a write handler.
_Avoid_: "exit interface" (reads as the uplink on the exit node's own machine, which is the opposite end), "tunnel" (every wg interface here is one)

**Exit Route Table**:
The policy-routing table belonging to one exit link (`peers.exitRouteTableId`, allocated from 52000-52999) that its clients' `ip rule`s point at. Per exit node, not per server - the table's `default dev <link>` names one exit link, which is exactly what makes "any client picks any exit node" expressible. It holds a complete route set, not just that default: an exit client's rule captures all of its traffic, so the vpn subnet, every exit node's `/32` and every advertised prefix are in there too.
_Avoid_: routing table (unqualified - the main table matters here too, and confusing the two is the `Table = off` bug)

**Advertised Subnet Route**:
A network *behind* a peer that the hub routes into that peer's tunnel (`peers.advertisedRoutes`), so permitted clients reach that LAN through it - Tailscale's `--advertise-routes`. Destination-based (`ip route <cidr> dev <iface>` in the main table, no per-client state) and permissioned by an ordinary `dstKind: 'cidr'` grant, which is what makes it a different mechanism from an exit node rather than a generalisation of one. One owner per prefix, host-wide - the route is a single main-table entry.
_Avoid_: site-to-site (implies both ends are managed here; only the advertiser is), exit node with a prefix (the permission and the routing direction are both different)

**Advertiser**:
The peer that advertises a subnet route. Not a role the peer holds toward other peers - it forwards for the LAN, not for the vpn - so unlike an exit node nothing references it by id.
_Avoid_: subnet router (Tailscale's term, but it suggests a distinct kind of node rather than an ordinary peer with a column set)

**Config Rendering**:
One of the several config texts `generatePeerConfig` can produce for a *single* peer row - normal, `?exit=true` (via its exit node), `?nat=true` (an exit node's or advertiser's own gateway config; the masquerade rule differs between the two). Renderings differ only in `AllowedIPs`, `DNS` and `PostUp`; key, address and endpoint are identical, which is what lets a client switch behaviour by switching files.
_Avoid_: config variant/second config (implies a second peer identity, which this deliberately avoids)

**Fleet Snapshot**:
One read of every server's `PolicyGraph`, in a stable order (`loadFleet`, `db/fleet.ts`). The two things this
manager applies host-wide - the single `table inet wgmgr` nft ruleset and the host's policy routing - are both
functions of exactly this, so `converge()` reads it once and hands it to both instead of each loading its own.
_Avoid_: "the state" (unqualified - a policy graph is state too, but scoped to one interface)

**Converge**:
Applying one server's wg interface plus the host-wide firewall and routing state, from a fleet snapshot. The one
seam every route handler calls after a mutation, whatever it changed - it is deliberately _not_ a choice between
"reload the interface" and "just resync the firewall", because that choice was silently wrong-able.
_Avoid_: sync (was the name of the two halves this replaced), reload (only the interface half)

**Exit Topology**:
The projection answering who an interface's exit node is, which peers route through it, and what subnet routes its
peers advertise (`exitTopologyOf`, `lib/exitTopology.ts`). Pure and io-free so the frontend shares it; the server
config, the nft ruleset and the policy routing each used to re-derive all three, tie-break rule included.
_Avoid_: exit config (suggests a rendering - this is a read over peer rows)

**Peer Intake**:
Resolving one peer write - create or update - into the column values to store, or a single error message
(`resolvePeerWrite`, `wg/peerIntake.ts`). Composes the address resolution, the cross-row invariants and the
advertised-route overlap check that the two handlers used to call in sequence, each in a different error shape.
_Avoid_: peer validation (only part of it - it also allocates the address and normalises the routes)

**Peer Invariants**:
The rules a peer write must satisfy that depend only on this server's peers, tags and grants - every exit-node
rule plus tag ownership (`checkPeerInvariants`, `lib/peerInvariants.ts`). Pure and free of db, http and CIDR
imports precisely so the peer form can decide with the same function the api decides with.
_Avoid_: constraints (implies the db enforces them; sqlite FK enforcement is off, so this module is the only place they hold)

**Server Scope**:
A route parameterized by a server's id, and the macro that authorizes it and resolves that row for the handler
(`serverScope` / `serverPeerScope`, `api/auth.ts`). Reaches the handler as `wgServer`, not `server`, because
elysia's own context already carries a readonly `server`.
_Avoid_: middleware (elysia calls these macros, and this one resolves rather than just gating)
