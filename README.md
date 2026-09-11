# wgfleet

**Self-hosted WireGuard® manager with real access control.** Run a fleet of WireGuard servers from a
single API, and control who can reach what with tag-based allow/deny policies that are enforced in
nftables on the server — not merely suggested by each client's config file.

Any stock WireGuard client works. There is no custom agent to install, no control-plane account, and
nothing phones home.

[![MIT license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Docker image](https://img.shields.io/badge/ghcr.io-mkuhlmann%2Fwgfleet-blue?logo=docker&logoColor=white)](https://github.com/mkuhlmann/wgfleet/pkgs/container/wgfleet)

![wgfleet server view](docs/screenshot.png)

## Why another WireGuard manager

Most self-hosted WireGuard tools are config managers: they hand out keys, addresses and `AllowedIPs`,
and any peer that reaches the tunnel reaches every other peer. The systems that do give you real
identity-based access control — Tailscale, NetBird, Firezone — expect their own client on every device.

wgfleet's distinguishing feature is the **policy model in between**: peers carry tags, reachability is
an ordered allow/deny list evaluated first-match-wins, an individual peer can override its tag's policy,
and the whole thing compiles to one nftables ruleset applied atomically across every server you manage.
Clients stay stock WireGuard and get no say in it. The two Tailscale features people tend to miss most
— exit nodes and advertised subnet routes — are here too, still without an agent.

Honest pointers to the neighbours, because they may fit you better:

- [**wg-easy**](https://github.com/wg-easy/wg-easy) — by far the simplest way to get one WireGuard
  interface and a handful of peers running. Single interface, no policy layer.
- [**wg-portal**](https://github.com/h44z/wg-portal) — multiple interfaces, LDAP-backed user management
  and a REST API. Reach for it if user management and self-service are what you need; it has no
  peer-to-peer policy layer.
- [**wireguard_webadmin**](https://github.com/eduardogsilva/wireguard_webadmin) — multiple instances,
  per-instance iptables rules, DNS blacklists, traffic graphs. The closest overlap; its firewall is
  configured per instance rather than as a tag-based policy across a fleet.
- [**Firezone**](https://github.com/firezone/firezone) / [**NetBird**](https://github.com/netbirdio/netbird)
  — full zero-trust platforms with SSO, MFA and NAT traversal, if you can deploy their client
  everywhere.

wgfleet was built to automate a large-scale VPN for thin clients across multiple locations, and I run it
in production. It is opinionated, and documentation is thin in places — feedback and pull requests
welcome.

## Features

- **Access policy that actually holds.** Tag your peers and write an ordered allow/deny list; a
  generated `nftables` ruleset enforces it. See [Access policy](#access-policy).
- **Many servers, one install.** Each WireGuard interface gets its own subnet, endpoint, listen port
  and policy. Peers are allocated addresses automatically from their server's CIDR range.
- **API-first.** Every screen in the UI is just a call to the same REST API, with an OpenAPI/Swagger
  document at `/swagger`. Automating wgfleet is the primary use case, not an afterthought.
- **No config files to babysit.** Interfaces, keys and peers live in SQLite and are applied to the
  running system; nothing is hand-edited on disk.
- **Client configs and QR codes**, so mobile clients can be enrolled by scanning.
- **Exit nodes.** Any peer can lend its own internet uplink to the others — Tailscale's
  `--advertise-exit-node`, without the client. The peer using it gets a second config file to switch
  to; nothing changes server-side. See [Exit nodes and subnet routes](#exit-nodes-and-subnet-routes).
- **Advertised subnet routes.** A peer can advertise a LAN behind it (`192.168.1.0/24`) so permitted
  clients reach that network through the tunnel. Who may reach it is an ordinary CIDR grant.
- **Traffic graphs and lifetime totals**, per server and per peer, rolled up at 1-minute (24h),
  1-hour (30d) and 1-day (400d) resolution.
- **Per-server internet egress (NAT)**, off by default, and never implicitly granted — a peer needs an
  explicit `internet` grant even once NAT is on.
- **DNS handed to clients** per server, with a per-exit-node override so a client on an exit node
  resolves through that node's network instead of its local one.
- **Scoped tokens.** Separate admin, per-server and per-peer bearer tokens.

Planned: a desktop client, and possibly SSO (OpenID Connect).

## Quick start

wgfleet ships as a single container. It needs `NET_ADMIN` and `SYS_MODULE` for WireGuard itself, two
sysctls, and a volume for its SQLite database (`/app/data`).

### Docker run

```bash
docker run -d \
  --name wgfleet \
  --env ADMIN_TOKEN="$(openssl rand -base64 32)" \
  --volume ./wg-data:/app/data \
  --publish 51820:51820/udp \
  --publish 3000:3000/tcp \
  --cap-add NET_ADMIN \
  --cap-add SYS_MODULE \
  --sysctl 'net.ipv4.conf.all.src_valid_mark=1' \
  --sysctl 'net.ipv4.ip_forward=1' \
  --restart unless-stopped \
  ghcr.io/mkuhlmann/wgfleet:latest
```

### Docker Compose

```bash
wget https://raw.githubusercontent.com/mkuhlmann/wgfleet/main/docker-compose.yml
# edit ADMIN_TOKEN, then:
docker compose up -d
```

Then open <http://localhost:3000> and log in with your `ADMIN_TOKEN`.

> ℹ️ If `ADMIN_TOKEN` is unset or shorter than 16 characters, a random one is generated on startup and
> printed to the log. Generate a durable one with `openssl rand -base64 32`.

For production, put a reverse proxy (Traefik, Caddy, nginx) in front for TLS termination. Publish one
UDP port per WireGuard server you intend to run.

### Configuration

| Variable                    | Default              | Purpose                                                              |
| --------------------------- | -------------------- | -------------------------------------------------------------------- |
| `ADMIN_TOKEN`               | random at boot       | God-mode bearer token; also the UI login.                            |
| `PORT`                      | `3000`               | HTTP port for the API and UI.                                        |
| `DATABASE_PATH`             | `../../data/sqlite.db` | SQLite file. Migrations run automatically on boot.                  |
| `WG_TRAFFIC_STATS_ENABLED`  | `true`               | Set `false` to stop collecting traffic samples and rollups.          |
| `WG_DEV_SHIM`               | unset                | `true` runs against in-memory fakes instead of real `wg`/`nft`/`ip`. |

## Access policy

By default a peer with no tags is **unrestricted** — every peer on a server can reach every other peer,
exactly like a hand-rolled WireGuard setup. Policy is opt-in, per server, and modelled on
Tailscale-style grants:

- A peer carries any number of **tags** (a many-to-many label, not a single group).
- Reachability is an explicit, **ordered list of grants** — `allow`/`deny`, matched top to bottom,
  first match wins.
- A grant's **source** is a tag or an individual peer. Putting a peer-scoped grant *above* a tag-scoped
  one overrides policy for one specific client without inventing a tag for it.
- A grant's **destination** is another tag, another peer, an arbitrary **CIDR** (typically a LAN a peer
  advertises — see [Exit nodes and subnet routes](#exit-nodes-and-subnet-routes)), the **server**
  itself (its tunnel address — DNS, the management API), the **internet**, or **any**. Grants can
  additionally match a protocol (`tcp`/`udp`/`icmp`) and a port list or range.
- A peer becomes **governed** the moment it carries a tag *or* is named as a grant's source: from then
  on its traffic is denied unless a grant allows it. A tag cannot even reach itself without a grant
  naming it as both source and destination.
- The **internet** destination additionally requires `enableNat` on that server, since egress is
  masqueraded. Turning NAT on grants nobody internet access by itself.

Because this compiles to an nftables ruleset applied atomically across all servers, a client cannot
opt out of it by editing its own config — `AllowedIPs` in a client config is a routing hint, and
wgfleet treats it as one.

Manage tags and grants from the **policy** view on a server's page (which includes a JSON view of the
whole policy document for review, export and import), or via the API.

## Exit nodes and subnet routes

Two ways to reach something that is not itself a peer. Both are configured on the peer that provides
it, and both work with stock WireGuard clients.

**An exit node** lends its own internet uplink to other clients. Mark a peer as the exit node — one per
interface, because only one peer can own `AllowedIPs = 0.0.0.0/0` on a WireGuard interface — then point
other peers at it. Each of those gets a *second* config rendering (`?exit=true` on either peer-config
route) whose only difference is `AllowedIPs = 0.0.0.0/0, ::/0`. Same key, same address, same endpoint,
so a client changes its exit path by switching config files and nothing changes on the server.

Routing is the permission here, not a firewall rule: the hub installs a policy route only for peers
that have been assigned an exit node, so a peer without one has no path to that uplink at all — editing
its own `AllowedIPs` gets it nowhere.

**An advertised subnet route** is the other half: a peer declaring a LAN behind it, e.g.
`192.168.1.0/24`, so clients can reach that network through it. This one adds no new permission
mechanism — the advertisement decides which peer owns the prefix, and an ordinary `allow → cidr` grant
decides who may reach it. A prefix can have only one owner across the whole install, so overlapping
advertisements are rejected rather than silently letting one peer steal another's traffic.

A peer can be both. Assign exit nodes from the peer dialog; review them, and the advertised routes, on
the server's **policy** view.

Either role means that peer's own machine forwards traffic. Download its config with `?nat=true` for
`PostUp`/`PostDown` lines that enable `ip_forward` and masquerade — onto its uplink for an exit node,
onto the LAN for an advertiser. Those lines need `wg-quick` as root on that machine.

> ⚠️ **`rp_filter` must be `0` or `2` (loose) on the host running wgfleet** for either feature. Replies
> arrive on the WireGuard interface with a source address the host's own routing table sends elsewhere,
> and strict reverse-path filtering (`1`) drops them — an otherwise-correct setup that simply does not
> work. Most distributions default to loose; wgfleet logs a warning when it finds strict filtering on an
> interface that has an exit node or an advertised route. Add
> `--sysctl 'net.ipv4.conf.all.rp_filter=2'` to the container if yours does not.

## API

The API lives under `/api/v1`, authenticated with a bearer token, and is documented interactively at
`/swagger`. Tokens come in three scopes: the admin token, a per-server token (authorizes everything
under that server, including all of its peers, tags and grants), and a per-peer token.

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/api/v1/wg/servers
```

| Endpoint                                          | Methods                  |
| ------------------------------------------------- | ------------------------ |
| `/wg/servers`                                     | `GET` `POST`             |
| `/wg/servers/:id`                                 | `GET` `PATCH`            |
| `/wg/servers/:id/config`                          | `GET`                    |
| `/wg/servers/:id/peers`                           | `GET` `POST`             |
| `/wg/servers/:id/peers/:peerId`                   | `PATCH` `DELETE`         |
| `/wg/servers/:id/peers/:peerId/config`            | `GET` (`?exit=true` for the via-exit-node rendering, `?nat=true` for the gateway one) |
| `/wg/peers/:id/config`                            | `GET` (peer-scoped token, same query parameters) |
| `/wg/servers/:id/tags`                            | `GET` `POST`             |
| `/wg/servers/:id/tags/:tagId`                     | `PATCH` `DELETE`         |
| `/wg/servers/:id/grants`                          | `GET` `PUT` (replaces all) |
| `/wg/servers/:id/policy`                          | `GET` `PUT` (tags + grants + assignments as one document) |
| `/wg/servers/:id/traffic`                         | `GET`                    |
| `/wg/servers/:id/traffic/reset`                   | `POST`                   |
| `/wg/servers/:id/peers/:peerId/traffic`           | `GET`                    |
| `/wg/servers/:id/peers/:peerId/traffic/reset`     | `POST`                   |
| `/auth/login`, `/auth/logout`, `/auth/verify`     | UI session endpoints     |

## Development

A Bun workspace monorepo: `packages/server` (Elysia + Drizzle/SQLite) and `packages/app` (Vue 3 + Vite
+ Tailwind). The frontend consumes the server's types directly through Eden Treaty, so there is no
generated client and no codegen step — changing a route changes the frontend's types immediately.

```bash
bun install
bun run dev        # server on :3000, vite on :5173 with an /api proxy
```

Local development needs neither root nor real WireGuard tooling: capabilities (`crypto`, `network`,
`firewall`) are probed independently at boot and shimmed in memory when missing. Force it with
`WG_DEV_SHIM=true`. In production, a missing capability is a fatal error rather than a silent fallback.

```bash
bun run --cwd packages/server test        # unit + integration tests
bun run --cwd packages/app type-check
```

The frontend has no tests yet. See [CLAUDE.md](./CLAUDE.md) for the architecture in detail, and
[DESIGN.md](./DESIGN.md) before touching the UI.

## License

[MIT](./LICENSE)

"WireGuard" is a registered trademark of Jason A. Donenfeld. This project is not affiliated with or
endorsed by the WireGuard project.
