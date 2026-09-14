# Access policy

By default a peer with no tags is **unrestricted** — every peer on a server can reach every other peer,
exactly like a hand-rolled WireGuard setup. Policy is opt-in, per server, and modelled on
Tailscale-style grants:

- A peer carries any number of **tags** (a many-to-many label, not a single group).
- Reachability is an explicit, **ordered list of grants** — `allow`/`deny`, matched top to bottom,
  first match wins.
- A grant's **source** is a tag or an individual peer. Putting a peer-scoped grant *above* a tag-scoped
  one overrides policy for one specific client without inventing a tag for it.
- A grant's **destination** is another tag, another peer, an arbitrary **CIDR** (typically a LAN a peer
  advertises — see [Exit nodes and subnet routes](./exit-nodes-and-subnet-routes.md)), the **server**
  itself (its tunnel address — DNS, the management API), or **any**. Grants can additionally match a
  protocol (`tcp`/`udp`/`icmp`) and a port list or range.
- A peer becomes **governed** the moment it carries a tag *or* is named as a grant's source: from then
  on its traffic is denied unless a grant allows it. A tag cannot even reach itself without a grant
  naming it as both source and destination.
- There is no **internet** destination. The hub does not masquerade, so there is no hub-side egress
  path to permit or deny — reaching the internet is an exit node, which is routing rather than policy.

Because this compiles to an nftables ruleset applied atomically across all servers, a client cannot
opt out of it by editing its own config — `AllowedIPs` in a client config is a routing hint, and
wgfleet treats it as one.

Manage tags and grants from the **policy** view on a server's page (which includes a JSON view of the
whole policy document for review, export and import), or via the [API](./api.md).
