# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is a Bun workspace monorepo (`packages/server`, `packages/app`). Root scripts run across both via `bun --filter`.

```bash
bun install                       # from repo root
bun run dev                       # root: runs `dev` in both packages in parallel (server on PORT / :3000, vite on :5173 w/ proxy)
```

**Server** (`packages/server`, Elysia + Bun + Drizzle/SQLite):
```bash
bun run --cwd packages/server dev              # bun --watch src/index.ts
bun run --cwd packages/server test             # NODE_ENV=test bun test --preload ./src/tests/setup.ts
bun test --preload ./src/tests/setup.ts src/api/policy.test.ts   # single file, run from packages/server
bun run --cwd packages/server build            # bun build src/index.ts --outdir dist --target bun
```
No real network/root privileges are needed for `dev` or `test` — see "Dev shim" below. There is no server-side
typecheck script; `tsc -p packages/server/tsconfig.json` currently fails (TS7 removed `moduleResolution: "node"`,
pre-existing, unrelated to app code) and isn't part of the workflow. Bun's own build/test strip types without
fully checking them, so `bun run --cwd packages/app type-check` (below) is the closest thing to a server-side
typecheck, since it transitively resolves the whole Elysia plugin chain through the `App` type (see Architecture).

**App** (`packages/app`, Vue 3 + Vite + Tailwind v4):
```bash
bun run --cwd packages/app dev            # vite dev server, proxies /api -> server port (PORT env, default :3000)
bun run --cwd packages/app build          # type-check + vite build
bun run --cwd packages/app type-check     # bun scripts/type-check.mjs --build - see the file's header comment for why
                                            # this isn't just `vue-tsc --build` (TS7 + Bun interop workarounds)
```
No app-level tests exist.

**Database** (`packages/server`, drizzle-kit, SQLite):
```bash
bun run --cwd packages/server drizzle-kit generate   # after editing src/db/schema.ts - writes drizzle/000N_*.sql
```
Migrations run automatically on server boot (`migrateDb()` in `src/index.ts`). `DATABASE_PATH` defaults to
`../../data/sqlite.db` relative to the server's CWD (`:memory:` under `NODE_ENV=test`).

Formatting: Prettier, tabs, single quotes, 250-char print width (`.prettierrc`). No lint script configured.

## Architecture

### Two packages, one type contract, no codegen

The frontend never calls a generated client or a hand-maintained schema package. `packages/app` depends on
`@wgfleet/server: workspace:*` and both tsconfigs alias `@server/*` -> `packages/server/src/*`, so
`packages/app/src/queries/edenClient.ts` does `treaty<App>(...)` (Eden Treaty) against
`export type App = typeof _app` from `packages/server/src/index.ts` directly. This means:
- **Adding/changing a server route or its TypeBox (`t.Object(...)`) schema changes the frontend's types
  immediately**, with no build step in between.
- The frontend also imports DB row types directly (`import type { Peer } from '@server/db/schema'`) instead of
  duplicating them.
- Field *shapes* are validated by Elysia's `t.*` on the server only. **Cross-row rules are shared**: the pure,
  io-free modules under `src/lib/` (`validation.ts`, `peerInvariants.ts`, `exitTopology.ts`) are imported by both
  the route handlers and the Vue modals, so a rule like "one exit node per interface" is stated once. Anything a
  modal still checks by hand (e.g. `ServerModal.vue`'s field formats) has to be kept in sync by hand - prefer
  moving a new cross-row rule into `src/lib/` over mirroring it.

### Server: Elysia plugin composition

`packages/server/src/index.ts` composes route plugins from `src/api/*.ts` (each an `Elysia` instance, e.g.
`serversRoutes`, `serversPeersRoute`, `peersRoutes`, `policyRoutes`) under `.group('/api/v1', ...)`, in front of a
static-file plugin serving `packages/app/dist` with an SPA fallback. Because `App` is `typeof _app`, TypeScript
must fully resolve every plugin's types to type-check anything that imports `App` - in practice this means the
app's typecheck (`type-check` above) transitively validates most of the server too.

**Auth** (`src/api/auth.ts`) is one `.macro({...})` call exposing four macros, with no user table.
`verifyAuth: { scope: 'admin' | 'server' | 'peer' }` authorizes only, and is now used just for admin-scoped
routes; `serverScope: true`, `serverPeerScope: true` and `peerScope: true` authorize **and resolve**, handing the
row to the handler as `wgServer` / `peer` (named `wgServer` because elysia's context already carries a readonly
`server`). A scoped route therefore starts at its own logic - no `resolveServer` + 404 preamble, and one db read
per request instead of two. All four must stay in that single `.macro()` call, written in elysia's object form,
or route `body`/`params` inference silently degrades to `any` across the whole `App` type - see the comment above
the call. Authorization is decided before the 404, so a nonexistent id still 401s an unauthenticated caller.

The credential model is unchanged: a bearer token either equals `process.env.ADMIN_TOKEN` (god-mode) or matches the `authToken`
column on the row named by `params.id` for that scope (`serverPeers.authToken` or `peers.authToken` - each row
carries its own credential, generated with `nanoid(32)`). A `server`-scoped token therefore authorizes every
route parameterized by that server's id, including all of its peers, tags and grants.

### Persistence: Drizzle + SQLite, no shared-schema layer

`src/db/schema.ts` defines seven tables (`adminSessionsTable` besides these six): `serverPeersTable` (one per WireGuard interface/server), `peersTable`
(clients, FK'd to a server), `peerTagsTable`, `peerTagAssignmentsTable` and `policyGrantsTable` (see "Restricted
clients" below). `peersTable` also carries the exit-node columns (`isExitNode`, `exitPeerId`, `exitDns`,
`advertisedRoutes`) and
`serverPeersTable` the interface's `dns` and its allocated policy-routing table (`routeTableId`) - see "Exit
nodes" below. **SQLite foreign-key enforcement is never turned on** (no `PRAGMA foreign_keys = ON` anywhere) -
`onDelete` clauses in the schema are declarative intent only; cascade/cleanup on delete is done by hand in the
API handler (see `DELETE /wg/servers/:id/tags/:tagId` in `src/api/policy.ts` for the pattern: an explicit
`db.transaction(...)` that unassigns members and deletes referencing grants before deleting the row itself).
`bun:sqlite` is a synchronous driver, so `db.transaction()` callbacks are synchronous too (`.run()`, not
`await`).

### Converging: one seam, one fleet read

`wg/converge.ts` is **the only sync a route handler calls**, whatever it changed:

```ts
await converge(server.id); // peers, servers, tags, grants, policy documents - all of them
```

It starts the wg interface if it isn't up and reloads it otherwise, then re-applies both host-wide artefacts (the
nft ruleset and the host's policy routing) from a single **fleet snapshot** - `loadFleet()` in `db/fleet.ts`, one
read of every server's `PolicyGraph`, in the stable order `buildRuleset`'s ordinal nft naming depends on.
`syncFirewall`/`syncExitRouting` take that snapshot rather than loading their own; they used to issue the same
N+1 query independently, twice per converge.

This used to be a choice - `converge()` for peer/server config, `syncFirewall()` alone for pure policy changes -
decided by hand at ten call sites against a rule that lived only in a comment, where picking wrong was a silent
routing bug rather than a failing test. A policy-only mutation now also reloads the interface: that is a
`wg syncconf` with identical content, and it puts every nft rebuild on converge's serialized chain instead of
letting a policy handler race a concurrent converge. `convergeHost()` (no interface step) exists for exactly one
caller, `wgManager` at boot, which has just started every interface itself.

Failures are logged, not thrown: a `ConvergeResult` of `{ ok: false }` means the mutation was still applied and
persisted. Handlers `log.warn` and return 200.

### The wg/ layer: real vs. shim, and three independent capability axes

`src/wg/shell.ts` is a capability-detecting dispatcher, evaluated once at import time (top-level `await`), that
picks between `shell.real.ts` (actual `wg`/`wg-quick`/`ip`/`nft` invocations) and `shell.shim.ts` (in-memory
fakes) **per capability**, not as a single on/off switch:

| Axis | Probed by | Powers |
|---|---|---|
| `crypto` | `Bun.which('wg')` | `wgGenKey`/`wgGenPsk`/`wgDerivePublicKey` |
| `network` | `wg-quick`+`ip` present, and an actual `ip link add ... type dummy` probe (binaries can exist without `NET_ADMIN`) | `startServer`/`reloadServer`/`stopServer`/`wgShow`/`isInterfaceUp`/`applyExitRouting` |
| `firewall` | `nft` present and `nft list tables` actually succeeds | `applyFirewall`/`resetFirewall` |

In production (`NODE_ENV=production`), missing any capability throws on boot unless `WG_DEV_SHIM=true` is set
explicitly - it will not silently fall back to shimmed behavior. Outside production, each missing capability
logs a warning and shims just that axis. **When adding a new exported function to this layer, add it to all
four files (`shell.ts`, `shell.real.ts`, `shell.shim.ts`, `shell.recording.ts`)** - `src/tests/setup.ts`'s
`mock.module('@server/wg/shell', ...)` re-exports `shell.recording.ts` wholesale for every test, so a function
missing from that adapter is `undefined` in every test. `shell.recording.ts` behaves like the shim but also
keeps a call log, which is how tests assert *that* a mutation reloaded an interface or resynced policy.

Local dev/tests never need root or real WireGuard tooling: `WG_DEV_SHIM=true bun run dev` (or just running
outside a privileged container) exercises the full app against the shim.

### Restricted clients: tags, ordered grants, and the firewall as the actual boundary

Peers carry a many-to-many set of **tags** (`peerTagAssignmentsTable`; no tags is **fully unrestricted**, same
escape hatch the old single-`groupId` model had). Reachability is `policyGrantsTable`: an explicit, per-server
**ordered list** (`position`, ascending) of `(action: allow|deny, src: tag|peer, dst: tag|peer|cidr|server|
internet|any, protocol, ports)` rows, evaluated first-match-wins - see the type comment atop `wg/firewall.ts` for
the full evaluation semantics. A peer becomes "governed" (denied by default absent a matching grant) the moment
it carries a tag *or* is named directly as a grant's `src` - this is what lets a peer-scoped grant placed above a
tag-scoped one express "override this tag's policy for one specific client", the feature this model replaced
`peerGroupsTable`/`peerGroupRulesTable`/`peers.groupId` to get (see migration `drizzle/0002_policy_grants.sql`
for how old groups/rules/booleans were carried forward as tags/grants). Grants are replaced wholesale per server
via `PUT /wg/servers/:id/grants` (delete-then-insert in one transaction, array index becomes `position`); the
whole policy (tags + grants + peer↔tag assignments) can also be read/written as one JSON document via
`GET`/`PUT /wg/servers/:id/policy`, addressing tags by name rather than id so a hand-edited document doesn't need
real ids for new tags.

**The client's own WireGuard config (`AllowedIPs`, in `src/wg/config.ts`) is a routing hint only, never the
enforcement boundary** - a client owns that file and can edit it. The actual boundary is a single nftables
`table inet wgmgr` generated by `src/wg/firewall.ts` and applied atomically (`table {}; delete table; table {...}`)
across *all* servers at once on every relevant mutation. **Route handlers never call it directly**: they call
`converge(serverId)` (see "Converging" above), which is the single seam for "apply what I just changed". Read the top-of-file comments in `firewall.ts` before touching it -
notable non-obvious invariants: nft object names are ordinal (`s{serverIdx}t{tagIdx}`), never derived from
nanoid ids or `interfaceName`, because those don't satisfy nft's identifier charset; a tag can't reach its own
members unless a grant explicitly names that tag as both `src` and `dst`; and enabling a server's `enableNat`
must not silently grant ungoverned peers internet access (there's an explicit forward-chain guard for this - see
the comment above `egressGuard` in `firewall.ts`).

`src/wg/firewall.ts` splits into a pure `buildRuleset(servers: FirewallServer[])` (no db, no io - this is what
`firewall.test.ts` drives directly with fixtures) and a thin `generateFirewallRuleset(fleet)`/`syncFirewall(fleet)`
that take the fleet snapshot (`loadFleet()` in `db/fleet.ts`) and apply it - they no longer read the db
themselves, so the ruleset and the exit routing always derive from the same snapshot. Keep new test scenarios on the pure function - `bun:sqlite` under
`NODE_ENV=test` is a single in-memory database shared across *all* test files in the same run, so anything
reading "all servers" from the db in a test would pick up fixtures inserted by unrelated test files (this is why
existing fixtures prefix ids per-file, e.g. `serversRouter-server`, `peersRouters-server`, `policyRouter-server`).

### Exit nodes: the peer as internet gateway, and routing as the permission

A peer marked `peers.isExitNode` lends its own uplink to other clients: a peer with
`peers.exitPeerId` pointing at it gets a **second config rendering** (`?exit=true` on either
peer-config route) whose only difference is `AllowedIPs = 0.0.0.0/0, ::/0` - same key, same
address, same endpoint - so the client switches exit path by switching config file, with no
server-side state change. The full traffic path and the rejected alternatives are in the
top-of-file comment on `wg/exitRouting.ts`. The three things most likely to surprise:

- **The `ip rule` is the permission, not the nft rule.** `wg/exitRouting.ts` installs
  `ip rule from <client>/32 table <server.routeTableId>` + `default dev <iface>` only for peers
  with an `exitPeerId`. A peer without one has no route to the exit node at all, so it can't
  reach that uplink by hand-editing its own `AllowedIPs`. The nft accept in `fwd_s{i}` exists
  only so a *governed* exit client isn't dropped by its default-deny first, and is emitted
  **after** every explicit grant so an admin `deny` still wins.
- **An exit-bearing interface's server config emits `Table = off`.** The exit peer owns
  `AllowedIPs = 0.0.0.0/0` server-side, and `wg-quick` would turn that into a default route on
  the *manager's own host*. With `Table = off` the connected route from `Address` is what makes
  peers routable, which is why `generateServerConfig` derives that prefix from `cidrRange`
  rather than assuming `/24`.
- **One exit node per interface**, api-enforced (`assertExitNodeInvariants` in
  `api/serversPeers.ts`) - only one peer can own `0.0.0.0/0` on a wg interface. That's a
  wireguard constraint, not a policy choice.

The same peer column set carries Tailscale's *other* half, **advertised subnet routes**
(`peers.advertisedRoutes`, a comma-separated ipv4 CIDR list of LANs behind that peer). It shares the `Table = off`
story and `wg/exitRouting.ts`, and nothing else - it is destination-routed (`ip route <cidr> dev <iface>` in the
**main** table, tagged `proto static` so a full reconcile can drain exactly its own routes; no `ip rule`, no
per-client state) and permissioned by an ordinary `dstKind: 'cidr'` grant rather than by a column. So it adds no
nft rule of its own - only a *subtraction*: the exit accept's `ip daddr != <cidrRange>` grows to
`!= { cidrRange, ...advertisedRoutes }`, or a governed exit client would reach every advertised LAN without a
grant. Overlap is rejected in `resolveAdvertisedRoutes` (`wg/addressing.ts`, pure) and checked **host-wide**, not
per interface: cryptokey routing gives one owner per prefix on an interface (the analogue of two exit nodes), but
the route itself is a single main-table entry, so a prefix another interface already advertises - or another
interface's own `cidrRange`, whose connected route would be overwritten - is just as unusable. That function also
network-aligns each entry, since `ip route` and nft both reject a prefix with host bits set.

Like `firewall.ts`, `exitRouting.ts` splits into a pure `buildExitRouting(servers)` (what
`exitRouting.test.ts` drives) and a thin `syncExitRouting()`; it runs at the *end* of
`converge()` because `ip route ... dev <iface>` needs the device to exist. Anything touching
`isExitNode`/`exitPeerId` changes the interface config too - which `converge()` handles, since it always applies
both the interface and the host-wide state.

### Frontend: no component library, one design system

`packages/app` is plain Vue 3 SFCs + Tailwind v4 utilities - **read `DESIGN.md` before touching any UI**. It
documents the "operator terminal console" system in detail (bracketed `[ action ]` buttons, `>` prompt glyphs,
`///` section markers, the `Base*` component set, the token palette in `src/assets/main.css`) and explicitly
lists what not to reach for (no PrimeVue/icon packages/second accent color - both were deliberately removed).
State: TanStack Vue Query for all server state (`src/queries/*.ts`, `queryOptions()` pattern, mutations inline
in the modal components that use them), a single Pinia store for the in-memory (non-persisted) auth token
(`src/stores/auth.ts` - reloading the page logs you out by design).

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`mkuhlmann/wgfleet`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: root `CONTEXT-MAP.md` plus a `CONTEXT.md` per package (`packages/app`, `packages/server`). See `docs/agents/domain.md`.
