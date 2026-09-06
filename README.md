# wg-api-manager

> ℹ️ **This project is still in development but useable.**

I created this project to manage an automated large scale wireguard vpn for thin clients in multiple locations. I also needed support for multiple wireguard servers, which as far as I know no other project supports. The project is primarily designed to be used with an api, but also provides a simple ui for managing configurations. I already use wg-api-manager in production use, but keep in mind it is still in development, opinionated, lacks testing and documention. I am happy about any feedback or pull-requests.

## Features

- Create and manage **multiple** WireGuard VPN configurations
- **No complex environment variables or configuration files**
- Automated ip allocation based on CIDR-subnet
- Supports multiple servers and endpoints
- Primarily designed to use api
- Optionally provides simple ui for managing configurations
- Automatically generate client configurations (including QR codes)
- Restricted clients: tag peers and write an ordered allow/deny policy (grants) controlling what each tag - or an
  individual peer - can reach, enforced server-side with nftables (see [Restricted Clients](#restricted-clients) below)
- Redirect traffic through the VPN, including full internet egress, per tag
- Traffic stats
- Authenticated with administration, server and peer token

## Planned Features

- Desktop client
- Perspectively sso (openid connect)

## Installation

### 1. Generate Adminstration Token

Generate an unique and cryptographically secure administration token.

```bash
openssl rand -base64 32
```

> ℹ️ if no token is provided (or is too short), a random token will be generated on startup and printed to the console.

### 2. Run wg-api-manager

wg-api-manager stores a sqlite database in the `/app/data` directory. Make sure to mount a volume to persist the database.

For the WireGuard VPN to work, the container needs the `NET_ADMIN` and `SYS_MODULE` capabilities. Additionally, the following sysctl settings are required:

```bash
sysctl 'net.ipv4.conf.all.src_valid_mark=1'
sysctl 'net.ipv4.ip_forward=1'
```

For production use, it is recommended to use a reverse proxy like Traefik to handle SSL termination.

#### Via docker run

```bash
docker run -d \
  --name wg-api-manager \
  --env ADMIN_TOKEN=(openssl rand -base64 32) \
  --volume ./wg-data:/app/data \
  --publish 51820:51820/udp \
  --publish 3000:3000/tcp \
  --cap-add NET_ADMIN \
  --cap-add SYS_MODULE \
  --sysctl 'net.ipv4.conf.all.src_valid_mark=1' \
  --sysctl 'net.ipv4.ip_forward=1' \
  --restart unless-stopped \
  ghcr.io/mkuhlmann/wg-api-manager:latest
```

#### Via docker-compose

Download the `docker-compose.yml` file from the repository and adjust the environment variables as needed.

```bash
wget https://raw.githubusercontent.com/mkuhlmann/wg-api-manager/main/docker-compose.yml
```

```bash
docker-compose up -d
```

## Restricted Clients

By default every peer on a server can reach every other peer - this is unchanged, and any peer you never tag
keeps behaving exactly this way.

Access control is a Tailscale-grants-style model, scoped per server:

- A peer can carry any number of **tags** (a many-to-many label, not a single group).
- Reachability is an explicit, **ordered list of grants** - `allow`/`deny` rules matched top to bottom, first
  match wins. A grant's source is a **tag** or an individual **peer**; a peer-scoped grant placed above a
  tag-scoped one lets you override policy for one specific client without inventing a whole new tag for it.
- A grant's destination is another **tag**, another **peer**, an arbitrary **subnet/CIDR** (useful for a
  site-to-site LAN behind the gateway), the **server** itself (its own tunnel address - dns, the management api),
  the **internet**, or **any**. Grants can optionally match a protocol (`tcp`/`udp`/`icmp`) and port list/ranges.
- The moment a peer carries a tag, or is named directly as a grant's source, it becomes **governed**: traffic
  from it is denied by default unless some grant allows it. Reaching itself (tag -> same tag) needs its own
  explicit grant, same as any other destination.
- The **internet** destination also requires `enableNat` to be turned on for that server, since this masquerades
  traffic on the way out. Off by default; turning it on for a server does not by itself grant internet access to
  anyone - an explicit "internet" grant is still required.

This is enforced with a generated nftables ruleset on the server, not by what a client's own config says it's
allowed to do - a client can't bypass it by editing its config. Manage tags and grants from the "policy" button
on a server's page (including a JSON view of the whole policy document for review/import), or via the
`/wg/servers/:id/tags`, `/wg/servers/:id/grants` and `/wg/servers/:id/policy` api endpoints.

## Testing

The server package has unit and integration tests (`bun run --cwd packages/server test`). The frontend
(`packages/app`) has no tests yet.
