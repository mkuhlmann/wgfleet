# Exit nodes and subnet routes

Two ways to reach something that is not itself a peer. Both are configured on the peer that provides
it, and both work with stock WireGuard clients.

## Exits

**An exit** lends an internet uplink to clients, and comes in two kinds.

The **server's own uplink** is the cheap one: turn it on in the server settings and any client may
select it, masqueraded out of the host wgfleet runs on. No extra interface, no extra UDP port, and the
client keeps dialing the endpoint it already dials.

**A peer exit node** lends *its* uplink instead — what you want when the exit has to be somewhere
else: a residential line, another country, a LAN. Mark any number of peers as exit nodes, then point
other peers at whichever exit they should use. Each client gets a *second* config rendering
(`?exit=true` on either peer-config route) whose only difference is `AllowedIPs = 0.0.0.0/0, ::/0`.
Same key, same address, same endpoint, so a client changes its exit path by switching config files —
and switching it to a *different* exit node later changes nothing on the client at all.

Selecting an exit is the permission — there is no grant for internet access. A client that selected
nothing gets no policy route and no masquerade, so it has no path to any uplink at all and editing its
own `AllowedIPs` gets it nowhere. Turning the server's exit on likewise grants nobody anything until a
client selects it: the masquerade is scoped to exactly the clients that did.

> ⚠️ **Marking a peer as an exit node does not change that peer's own config by itself.** You have to
> reinstall it: it now connects to that dedicated interface, so its `Endpoint` port and the hub public
> key both change, and it needs the [gateway lines](#gateway-configuration-nattrue) below. (The
> server's own exit needs no such step.) Until you do and restart its tunnel, its clients time out
> while the UI, the handshake and the ruleset all look correct. This is the single most common reason
> a new exit node appears not to work.

### Why a peer exit node needs a port and the server does not

WireGuard picks which peer to encrypt a packet to from the packet's **destination address alone**, and
every exit client wants the same destination: the whole internet, `0.0.0.0/0`. That prefix has exactly
one owner per interface, and assigning it to a second peer does not fail — it silently takes it away
from the first.

There is no way around that with routing or nftables. A next hop is an Ethernet concept a WireGuard
device has no use for — `ip route add 8.8.8.8 via <peer> dev wg0` sends nothing — and the only lever
nftables has over peer selection is the destination address, which is exactly what you need to keep.

The **server** never hits this, because it is not a peer of its own interface: it just masquerades the
selected clients out of its own default route, needing no interface, key or port.

A **peer** exit node does, so each gets **a WireGuard interface of its own on the hub** (`wgx0`,
`wgx1`, …) with exactly one peer on it. Nothing competes for `0.0.0.0/0`, and "which exit does this
client use" becomes an ordinary routing question — a source rule per client:

```
ip rule add from 10.0.0.12/32 table 52000   # → default dev wgx0 → peer exit node A
ip rule add from 10.0.0.13/32 table 52001   # → default dev wgx1 → peer exit node B
# a client exiting via the server needs no rule at all: the host's own default route already goes
# where it wants, and an nft masquerade scoped to exactly those clients is the whole of it
```

Your clients are untouched by this: they all stay on the server's own interface, keep their keys,
addresses and endpoint, and still reach every peer — including exit nodes — exactly as before.

> ⚠️ **Each *peer* exit node needs its own UDP port published — on the wgfleet host, not on the exit
> node.** The exit node *dials in*, exactly like any other peer, so it works from behind NAT or CGNAT
> with nothing opened on its side; the hub is the one that has to be reachable. wgfleet allocates a
> port from `51900-51999` (or you pin one in the peer dialog) and shows it on the server's **policy**
> view — publish it on the container (`-p 51900:51900/udp`) and allow it inbound. The server's own
> exit needs none of this. See [Configuration](./configuration.md#ports-to-publish).

## Advertised subnet routes

**An advertised subnet route** is the other half: a peer declaring a LAN behind it, e.g.
`192.168.1.0/24`, so clients can reach that network through it. This one adds no new permission
mechanism — the advertisement decides which peer owns the prefix, and an ordinary `allow → cidr` grant
decides who may reach it. A prefix can have only one owner across the whole install, so overlapping
advertisements are rejected rather than silently letting one peer steal another's traffic.

A peer can be both. Assign exit nodes from the peer dialog; review them, and the advertised routes, on
the server's **policy** view.

## Gateway configuration (`?nat=true`)

Either role means that peer's own machine forwards traffic. Download its config with `?nat=true` for
`PostUp`/`PostDown` lines that turn it into a gateway. Those lines need `wg-quick` as root on that
machine. They do three things:

1. **Enable forwarding** — `net.ipv4.ip_forward=1`, falling back to *reading* the value where
   `/proc/sys` is read-only (a container or unprivileged LXC), since `wg-quick` aborts the whole
   interface if a `PostUp` line fails.
2. **Open `filter/FORWARD`** — one `-I FORWARD 1` accept for traffic arriving from the VPN subnet, and
   one for the established replies going back. See the note below.
3. **Masquerade** — onto its uplink for an exit node, onto the LAN for an advertiser. The advertiser's
   rule is scoped to the VPN subnet, because a blanket masquerade would also rewrite that machine's own
   LAN traffic.

The uplink and LAN interface names are resolved *on the gateway machine* at bring-up (`ip -4 route
show …`, matched with bash regex rather than `awk`, which some AppArmor profiles block for `wg-quick`).
wgfleet cannot see that machine's interfaces, and a wrong guess would produce a gateway that looks
configured and silently NATs nothing.

> ℹ️ **Why the FORWARD rules are there.** Masquerading is only half a gateway: the NAT rules live in
> `nat/POSTROUTING`, which rewrites a packet but never decides whether it is forwarded at all —
> `filter/FORWARD` does. Distributions differ, and the failure mode differs with them:
>
> | Host | `FORWARD` chain | Symptom without the accepts |
> | --- | --- | --- |
> | Debian, Ubuntu | empty, policy `ACCEPT` | none — works either way |
> | RHEL, Fedora, firewalld | trailing `REJECT --reject-with icmp-host-prohibited` | client sees `Destination Host Prohibited` |
> | any host running docker | policy `DROP` | silent timeout |
>
> The rules are **inserted** at position 1 rather than appended, since an appended rule lands after
> that trailing reject and never matches, and are **scoped to the VPN subnet** rather than accepting
> everything on the interface, so that jumping to the head of the chain does not pre-empt the
> deliberate rules of a machine that is also someone's router.

> ⚠️ **On a firewalld host these rules are necessary but not sufficient.** `iptables-nft` writes into
> the `filter` table while firewalld keeps its own; both base chains run at the forward hook, and a
> reject in either one still wins. Put the tunnel interface in a trusted zone instead of relying on the
> generated lines:
>
> ```bash
> firewall-cmd --permanent --zone=trusted --add-interface=wg0   # the interface wg-quick brings up
> firewall-cmd --permanent --zone=public --add-masquerade
> firewall-cmd --reload
> ```

> ⚠️ **Two sysctls on the wgfleet host decide whether either feature works at all**, and both fail as a
> plain timeout with everything else looking healthy. wgfleet warns about each in its log rather than
> changing them underneath you.
>
> - `net.ipv4.ip_forward` must be `1`. Both features *are* forwarding: a packet arrives on a WireGuard
>   interface addressed elsewhere and has to go back out. The `docker run` and Compose examples set it;
>   a deployment that drops those `--sysctl` flags silently forwards nothing.
> - `net.ipv4.conf.all.rp_filter` and the per-interface value must be `0` or `2` (loose) — the kernel
>   uses whichever is *higher*. Replies arrive on the WireGuard interface with a source address the
>   host's own routing table sends elsewhere, and strict reverse-path filtering (`1`) drops them. Most
>   distributions default to loose; add `--sysctl 'net.ipv4.conf.all.rp_filter=2'` if yours does not.
