# Server

Manages WireGuard servers and their peers: identity/keys, address assignment, firewall policy, and traffic accounting.

## Language

**Peer Address Resolution**:
Deciding the wgAddress a peer gets - either validating a caller-requested address against the server's CIDR range and its other peers, or auto-allocating the next free one starting from the server's reserved-IPs offset.
_Avoid_: IP allocation (too generic - this is always scoped to one server's peers)

**Exit Node**:
A peer that lends its own internet uplink to other clients on the same interface (`peers.isExitNode`). It stays an entirely ordinary peer - reachable, and reaching others - and owns `AllowedIPs = 0.0.0.0/0` only in the *server-side* config, where longest-prefix matching keeps every other peer's `/32` winning. At most one per interface, because only one peer can own `0.0.0.0/0` on a wg interface.
_Avoid_: gateway (ambiguous - the hub is also a gateway when `enableNat` is on), relay (implies it forwards vpn traffic, which is the hub's job)

**Exit Client**:
A peer whose `exitPeerId` names an exit node, meaning its internet-bound traffic is policy-routed into that node's tunnel. The column is both the permission and the routing instruction: without it no `ip rule` exists, so the peer has no route to any exit node and cannot reach one by editing its own config.
_Avoid_: "peer with internet access" (that's the `enableNat` + `internet`-grant path, which goes out the hub's uplink instead)

**Exit Route Table**:
The per-interface policy-routing table (`serverPeers.routeTableId`, allocated from 52000-52999) holding the `default dev <iface>` route that exit clients' `ip rule`s point at. Per-interface rather than per-peer so unmarking and re-marking an exit node never churns the number under live traffic.
_Avoid_: routing table (unqualified - the main table matters here too, and confusing the two is the `Table = off` bug)

**Config Rendering**:
One of the several config texts `generatePeerConfig` can produce for a *single* peer row - normal, `?exit=true` (via its exit node), `?nat=true` (an exit node's own gateway config). Renderings differ only in `AllowedIPs`, `DNS` and `PostUp`; key, address and endpoint are identical, which is what lets a client switch behaviour by switching files.
_Avoid_: config variant/second config (implies a second peer identity, which this deliberately avoids)
