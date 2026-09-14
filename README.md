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
  generated `nftables` ruleset enforces it. See [Access policy](docs/access-policy.md).
- **Many servers, one install.** Each WireGuard interface gets its own subnet, endpoint, listen port
  and policy. Peers are allocated addresses automatically from their server's CIDR range.
- **API-first.** Every screen in the UI is just a call to the same REST API, with an OpenAPI/Swagger
  document at `/swagger`. Automating wgfleet is the primary use case, not an afterthought.
- **No config files to babysit.** Interfaces, keys and peers live in SQLite and are applied to the
  running system; nothing is hand-edited on disk.
- **Client configs and QR codes**, so mobile clients can be enrolled by scanning.
- **Exit nodes, as many as you like.** The server can lend its own uplink, and so can any peer —
  Tailscale's `--advertise-exit-node`, without the client. Every client picks which exit it uses and
  gets a second config file to switch to; switching later changes nothing else about it.
  See [Exit nodes and subnet routes](docs/exit-nodes-and-subnet-routes.md).
- **Advertised subnet routes.** A peer can advertise a LAN behind it (`192.168.1.0/24`) so permitted
  clients reach that network through the tunnel. Who may reach it is an ordinary CIDR grant.
- **Traffic graphs and lifetime totals**, per server and per peer, rolled up at 1-minute (24h),
  1-hour (30d) and 1-day (400d) resolution.
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
  --publish 51900-51909:51900-51909/udp \
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

Then open <http://localhost:3000> and log in with your `ADMIN_TOKEN`. If `ADMIN_TOKEN` is unset or
shorter than 16 characters, a random one is generated on startup and printed to the log.

> ⚠️ **Two kinds of UDP port have to be published**: one per WireGuard server (`51820` above), and one
> per *peer* exit node, allocated from `51900` upwards. Forgetting the second is the most common way a
> peer exit node ends up unable to connect at all — see
> [Configuration](docs/configuration.md#ports-to-publish).

For production, put a reverse proxy (Traefik, Caddy, nginx) in front for TLS termination.

## Documentation

| Document | What's in it |
| --- | --- |
| [Configuration](docs/configuration.md) | Environment variables, which ports to publish, host sysctls, capabilities. |
| [Access policy](docs/access-policy.md) | Tags, ordered grants, what "governed" means, why a client cannot opt out. |
| [Exit nodes and subnet routes](docs/exit-nodes-and-subnet-routes.md) | Both exit kinds, why a peer exit node needs its own port, advertised LANs, and the `?nat=true` gateway config. |
| [API](docs/api.md) | Token scopes and the endpoint table. Interactive docs live at `/swagger`. |
| [Development](docs/development.md) | Monorepo layout, running it locally without root, tests. |

## License

[MIT](./LICENSE)

"WireGuard" is a registered trademark of Jason A. Donenfeld. This project is not affiliated with or
endorsed by the WireGuard project.
