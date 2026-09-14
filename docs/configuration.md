# Configuration

## Environment variables

| Variable                    | Default                | Purpose                                                             |
| --------------------------- | ---------------------- | ------------------------------------------------------------------- |
| `ADMIN_TOKEN`               | random at boot         | God-mode bearer token; also the UI login.                           |
| `PORT`                      | `3000`                 | HTTP port for the API and UI.                                       |
| `DATABASE_PATH`             | `../../data/sqlite.db` | SQLite file. Migrations run automatically on boot.                  |
| `WG_TRAFFIC_STATS_ENABLED`  | `true`                 | Set `false` to stop collecting traffic samples and rollups.         |
| `WG_DEV_SHIM`               | unset                  | `true` runs against in-memory fakes instead of real `wg`/`nft`/`ip`. |

> ℹ️ If `ADMIN_TOKEN` is unset or shorter than 16 characters, a random one is generated on startup and
> printed to the log. Generate a durable one with `openssl rand -base64 32`.

## Ports to publish

**Two kinds of UDP port have to be published**, and forgetting the second is the most common way a
peer exit node ends up unable to connect at all:

- **one per WireGuard server** — `51820` in the quick start, whatever you set as that server's listen
  port;
- **one per *peer* exit node** — each connects to a *dedicated interface* on the hub rather than to
  its server's, on its own port allocated from `51900` upwards. The examples publish `51900-51909`,
  which covers ten; the exact port for each is shown on the server's **policy** view. Using only the
  server's own exit needs none of these — see
  [Exit nodes and subnet routes](./exit-nodes-and-subnet-routes.md#why-a-peer-exit-node-needs-a-port-and-the-server-does-not).

The HTTP port (`3000`) carries the API and UI. For production, put a reverse proxy (Traefik, Caddy,
nginx) in front of it for TLS termination.

## Host sysctls

wgfleet needs `net.ipv4.conf.all.src_valid_mark=1` and `net.ipv4.ip_forward=1`; exit nodes and
advertised routes additionally need loose reverse-path filtering. Both forwarding-related settings
fail as a plain timeout with everything else looking healthy — see
[Exit nodes and subnet routes](./exit-nodes-and-subnet-routes.md#gateway-configuration-nattrue) for
the detail.

## Capabilities and storage

The container needs `NET_ADMIN` and `SYS_MODULE` for WireGuard itself, and a volume for its SQLite
database at `/app/data`.
