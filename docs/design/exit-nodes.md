# Exit nodes

An exit node is a peer whose own internet uplink other clients can be routed through — the
same idea as Tailscale's `--advertise-exit-node`. This document covers the implemented
design, then the deliberately-deferred follow-up (advertised subnet routes) in enough detail
to be picked up cold.

## The shape of it

One interface, one peer row per client, two config renderings.

```
server wg0, cidr 10.0.0.0/24
  peer a  10.0.0.2   isExitNode = true
  peer b  10.0.0.3   exitPeerId = a
```

Peer `b` downloads two files that differ in one line:

```ini
# b-normal.conf                    # b-via-a.conf
AllowedIPs = 10.0.0.0/24           AllowedIPs = 0.0.0.0/0, ::/0
```

Same key, same address, same endpoint. Nothing about the server changes when `b` switches
files — the server side is static and identical for both. All that differs is whether `b`
encrypts its internet traffic to the hub or sends it out its own uplink.

## Traffic path

For `b → 8.8.8.8` while using `b-via-a.conf`:

1. `b` encrypts to the hub, because its `AllowedIPs` is `0.0.0.0/0`.
2. The hub's inbound cryptokey check passes — `src 10.0.0.3` is inside `b`'s `/32`.
3. `ip rule from 10.0.0.3/32 table 52000` → `default dev wg0 table 52000` sends it back out
   the wg interface instead of the hub's own uplink (`wg/exitRouting.ts`).
4. nft `fwd_s0` accepts it via the exit-clients rule (`wg/firewall.ts`).
5. Outbound cryptokey routing on `wg0`: `8.8.8.8` matches `a`'s `0.0.0.0/0`. Every other
   peer's `/32` is more specific and still wins, so **`a` remains an entirely ordinary peer** —
   reachable, and reaching others, exactly as before.
6. `a` masquerades onto its own uplink. Replies come back through the hub's connected route
   to `b`.

`enableNat`'s masquerade rule is `oifname != <managed interfaces>`, and exit traffic leaves
_via_ `wg0`, so it does not fire. No double NAT — the exit node does its own.

## Why routing is the permission

A peer with no `exitPeerId` gets no `ip rule`. Its internet-bound packets fall through to the
main routing table, leave via a non-wg interface, and are dropped by the `egressGuard` in
`wg/firewall.ts`. It cannot reach the exit node's uplink by hand-editing its own
`AllowedIPs`, because the hub never routes its traffic there in the first place.

That is what lets `peers.exitPeerId` be both the permission and the routing instruction, with
no new permission mechanism. It also means the nft rule is not the boundary here — it exists
so a _governed_ exit client isn't dropped by its default-deny before routing gets a chance.

## Where the policy authority stays

The exit accept in `fwd_s{i}` is emitted **after** every explicit grant:

```
ip saddr @s0_exitclients oifname "wg0" ip daddr != 10.0.0.0/24 accept comment "exit node"
ip saddr @s0_governed drop
return
```

An admin's `deny` grant placed above it still wins, so the ordered grants list keeps its
authority and `exitPeerId` only ever adds this one narrow allowance at the bottom. The
`ip daddr != <cidrRange>` clause keeps it to internet-bound traffic — reaching other peers on
the interface remains entirely a matter of grants. Exit clients are deliberately **not** added
to `governedIps`: assigning an exit node must not change whether a peer is governed.

## `Table = off`

Putting `0.0.0.0/0` in a peer's `AllowedIPs` in the **server-side** config makes `wg-quick up`
install a default route (plus its fwmark kill-switch rule) on the host running this manager,
hijacking the manager's own internet. So an interface with an exit node emits `Table = off`
and the routes are managed by hand.

That is nearly free: `generateServerConfig` only ever emits peer `AllowedIPs` inside
`cidrRange`, so the connected route derived from the interface's `Address` covers every peer.
This is why `interfaceAddress()` derives the prefix from `cidrRange` instead of the old
hardcoded `/24` — with `Table = off` that prefix becomes the only thing making peers routable,
and a `/24` on a `/16` server would blackhole most of them.

`Table = off` is only emitted for interfaces that actually have an exit node, so a deployment
that never touches the feature keeps generating byte-identical configs.

## Routing tables

Allocated explicitly at server-create time (`allocateRouteTableId` in `db/servers.ts`), lowest
free in **52000–52999**, stored on `serverPeers.routeTableId`. Not derived from an ordinal:
the id has to stay stable for the life of the interface, and an ordinal would renumber every
surviving server's table when one is deleted — under live traffic, silently retargeting
another interface's default route.

`buildExitRouting` skips any server whose `routeTableId` falls outside that band rather than
touching a table this manager doesn't own.

## Reconcile, not incremental

`wg/exitRouting.ts` splits the same way `wg/firewall.ts` does: a pure `buildExitRouting()`
(no db, no io — what `exitRouting.test.ts` drives) and a thin `syncExitRouting()` that loads
state and applies it. Every table is drained before it is repopulated, so applied state is a
function of the db alone. `ip rule` has no upsert, so the drain is a bounded
delete-until-it-fails loop.

`syncExitRouting()` runs at the **end** of `converge()`, after `syncFirewall()`, because
`ip route ... dev <iface>` needs the device to already exist.

### Rejected: marking in nftables

Marking exit clients with `meta mark set` and matching `ip rule fwmark` would move all
per-client churn into the atomically-replaced nft ruleset, which is appealing. It was rejected
because it couples exit routing to the independently-probed `firewall` capability axis
(`wg/shell.ts`): a host with real `network` but shimmed `firewall` would silently lose exit
routing. Per-client `ip rule` needs only the `network` axis.

## Invariants (api-enforced, not db constraints)

sqlite FK enforcement is never turned on in this codebase, so
`assertExitNodeInvariants` in `api/serversPeers.ts` is the only place these hold:

| Rule                                                                          | Why                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At most one `isExitNode` peer per server                                      | Only one peer can own `AllowedIPs 0.0.0.0/0` on a wg interface. A wireguard cryptokey-routing constraint, not a policy choice — a second exit node needs a second interface. |
| `exitPeerId` must name a peer on the **same** server carrying `isExitNode`    | A cross-server id would route a client into a table whose default route belongs to another interface.                                                                        |
| A peer cannot be an exit node **and** use one                                 | Routing loop, and the two roles need different `AllowedIPs`.                                                                                                                 |
| A peer cannot use **itself** as its exit node                                 | Same.                                                                                                                                                                        |
| Unmarking an exit node is **rejected** while clients still reference it       | Fails closed and loudly. Silently unassigning them leaves them with no internet and nothing in the UI explaining why.                                                        |
| Deleting an exit node **is** allowed, and nulls out its clients' `exitPeerId` | The peer is gone, so there's nothing to reassign to. Reported in the response so the UI can name the affected clients.                                                       |
| `exitPeerId` is rejected alongside a **peer-scoped** `allow → internet` grant | Routing wins, so the grant would be silently inert.                                                                                                                          |

That last one has a known gap: a **tag-derived** `internet` grant can't be cheaply rejected at
write time, since it depends on the whole policy graph. The UI's three-way internet selector
prevents creating that state, but adding a tag later can still produce it. When it happens,
routing wins and the grant is inert — no security consequence, just a misleading policy row.

## IPv6

The exit rendering emits `AllowedIPs = 0.0.0.0/0, ::/0`. This codebase is v4-only throughout
(peers have no v6 address), so `::/0` **blackholes** v6 rather than tunnelling it. Without it,
every v6 packet would leave via the client's local uplink, bypassing the exit node entirely —
the exact leak an exit node exists to prevent. Deliberately not a toggle: its only "off"
setting leaks.

## Deploy prerequisites

- `net.ipv4.ip_forward=1` on the hub. Already required by existing peer-to-peer forwarding;
  nothing in this repo sets it.
- **`rp_filter` must be `0` or `2` (loose) on the wg interface.** Replies arriving from the
  exit node have an internet source address on `wg0`, and strict reverse-path filtering (`=1`)
  drops them, since that source routes via the hub's own uplink. Most distros default to
  loose. This is the single most likely reason an otherwise-correct setup looks broken, so
  `syncExitRouting()` logs a warning when it sees `rp_filter == 1` on an interface that has an
  exit node. It does not change the host's sysctl on the operator's behalf.
- The exit node needs `wg-quick` as root for the generated `PostUp` lines to run.

## The exit node's own machine

Opt-in at download time (`?nat=true`), never stored — it's a rendering concern:

```ini
PostUp = sysctl -q -w net.ipv4.ip_forward=1
PostUp = iptables -t nat -A POSTROUTING -o $(ip -4 route show default | awk '{print $5; exit}') -j MASQUERADE
PostDown = iptables -t nat -D POSTROUTING -o $(ip -4 route show default | awk '{print $5; exit}') -j MASQUERADE
```

The uplink interface is resolved **on the exit node** at bring-up rather than guessed by the
manager, which has no way to see that machine's interfaces — and a wrong guess produces an
exit node that looks configured and silently NATs nothing. `iptables` rather than `nft`,
since nothing is known about that machine's OS.

## Known limits, by design

- **One exit node per interface.** A wireguard constraint (see the invariants table). A second
  exit node needs a second server/interface.
- **No tag-scoped exit assignment.** `exitPeerId` is a column on the peer, so "all laptops use
  exit node a" is set per peer rather than per tag.
- **No automatic fallback when the exit node is offline.** Its clients lose internet until it
  returns or is reassigned. Falling back to the hub's uplink would push their traffic out the
  exact interface an exit node exists to avoid, so it fails closed. The UI surfaces a stale
  handshake and the count of affected clients instead.
- IPv4 only, matching the rest of the codebase.

---

# Follow-up: advertised subnet routes

**Not implemented.** This is the other half of Tailscale's model (`--advertise-routes`): an
exit node — or any peer — advertising a LAN behind it, e.g. `192.168.1.0/24`, so permitted
clients can reach that network through it.

It is a genuinely **different mechanism** that happens to live on the same peer, which is why
it does not share the `isExitNode` column:

|                       | Exit node (implemented)                                         | Advertised routes (this)                                                                                                  |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Traffic               | internet-bound (`0.0.0.0/0`)                                    | destined for a specific CIDR                                                                                              |
| Hub routing           | **source**-based: `ip rule from <client>` + per-interface table | **destination**-based: `ip route add 192.168.1.0/24 dev wg0` in the main table. No `ip rule`, no per-client state at all. |
| Permission            | `peers.exitPeerId`                                              | the **existing** `dstKind: 'cidr'` grants — no new permission mechanism needed                                            |
| Client `AllowedIPs`   | `0.0.0.0/0, ::/0` (separate rendering)                          | `+= 192.168.1.0/24` in the _normal_ rendering (`allowedIpsForPeer` already does this for `cidr` grants)                   |
| NAT on the advertiser | required                                                        | required only if the LAN has no route back to the vpn                                                                     |

## What it would take

1. **Schema:** a new nullable `peers.advertisedRoutes` text column holding a comma-separated
   CIDR list. Separate from `isExitNode`; sharing a column would couple two unrelated code
   paths for no gain.
2. **`wg/config.ts`:** the advertiser's server-side `AllowedIPs` becomes
   `<peer.wgAddress>, <each advertised cidr>`. Note this composes with the exit node case —
   a peer could be both, giving `0.0.0.0/0, <ip>/32, 192.168.1.0/24` (the `/0` already covers
   the LAN, so the explicit entry matters only for readability and for the non-exit case).
3. **Routing:** `ip route add <cidr> dev <iface>` in the **main** table. This is why
   `Table = off` (already emitted for exit interfaces) has to grow to cover
   advertisement-only interfaces too — otherwise `wg-quick` installs these routes itself,
   which would actually be fine, but two systems managing the same routes is not.
4. **`wg/firewall.ts`:** nothing new for permission — a `dstKind: 'cidr'` grant already
   compiles to `ip daddr <cidr> accept`. It probably does need the reverse direction
   considered: replies from the LAN are `ct state established,related`, already accepted.
5. **`db/policyGraph.ts`:** `allowedIpsForPeer` already appends `cidr`-dst grants, so a
   permitted client's normal config gains the LAN automatically. Worth a test asserting that.
6. **Validation:** the interesting part. Two peers advertising **overlapping** CIDRs on the
   same interface is the analogue of two exit nodes — wireguard cryptokey routing has one
   owner per prefix, so the second advertiser silently steals traffic. Needs an
   overlap check across the interface's advertised routes (not just exact-duplicate). Also
   worth rejecting a CIDR that overlaps the server's own `cidrRange`.
7. **UI:** a CIDR list field on the peer, and a "subnet routes" section in the exit-nodes
   panel on the policy view.
8. **Docs:** fold into this file rather than a new one; the two features share the
   `Table = off` and hub-forwarding story.

## Gotchas carried over

- `rp_filter` — same issue, same fix.
- The advertiser needs `ip_forward=1`, and MASQUERADE only if its LAN can't route back to the
  vpn subnet. Worth a separate `?nat=` variant from the exit node's, since the correct rule is
  `-s <vpn cidr> -o <lan iface>` rather than a blanket masquerade.
- IPv4 only, like everything else here (`isIpv4Cidr` in `wg/firewall.ts` already gates this
  for grants and should gate the new column too).
