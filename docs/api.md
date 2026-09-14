# API

The API lives under `/api/v1`, authenticated with a bearer token, and is documented interactively at
`/swagger`. Tokens come in three scopes: the admin token, a per-server token (authorizes everything
under that server, including all of its peers, tags and grants), and a per-peer token.

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/api/v1/wg/servers
```

Every screen in the UI is a call to these same routes — automating wgfleet is the primary use case,
not an afterthought.

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

The two peer-config query parameters are explained in
[Exit nodes and subnet routes](./exit-nodes-and-subnet-routes.md).
