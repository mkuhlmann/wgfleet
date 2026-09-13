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
- Field *shapes* are validated by Elysia's `t.*` on the server only. **Every other rule is shared**: the pure,
  io-free modules under `src/lib/` - `validation.ts`, `exitTopology.ts` and one `*Invariants.ts` per entity
  (`peerInvariants`, `serverInvariants`, `grantInvariants`, `tagInvariants`) - are imported by both the route
  handlers and the Vue modals, so a rule like "a peer cannot be an exit node and use one", or "that udp port is
  taken", is stated once and checkable on both sides. **A rule a modal states by hand is a bug** - every such
  mirror that existed had drifted (the grant form's copy of the ports rule was missing the max-entries check;
  the server form checked an address format the api had no equivalent for, and disagreed with it about
  trailing prefixes). Put a new rule in `src/lib/` and call it from both.
- Each invariant module returns a `Failure` (`lib/failure.ts`) - a message **plus the request field it is
  about** - or null. `api/failure.ts`'s `fail(code, failure)` is the only thing that turns one into an http
  response, so every error body is json of exactly that shape, and `queries/edenClient.ts` decodes it once and
  throws an `ApiError` carrying the field. That is what lets a modal put a server-side refusal on the input
  that caused it (see `queries/useWrite.ts`'s `fields` option).

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
`advertisedRoutes`) and, for a peer that *is* an exit node, the five columns describing the wg interface it gets
to itself (`exitInterfaceName`, `exitPrivateKey`, `exitPublicKey`, `exitListenPort`, `exitRouteTableId`);
`serverPeersTable` carries the interface's `dns` - see "Exit nodes" below. **SQLite foreign-key enforcement is never turned on** (no `PRAGMA foreign_keys = ON` anywhere) -
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

It runs exactly three steps, and the split is the point:

1. **`reconcileExitLinks`** (see "Exit nodes" below) - the only one that *writes*, allocating or releasing a
   peer's five exit-link columns. Everything below is read after it.
2. **`planConverge(...)`** (`wg/plan.ts`) - **pure**. Takes one **fleet snapshot** (`loadFleet()` in
   `db/fleet.ts`, one read of every server's `PolicyGraph`, in the stable order `buildRuleset`'s ordinal nft
   naming depends on) plus one `listInterfaces()` look at the host, and returns a `ConvergePlan`: an *ordered*
   list of interface steps (`start` / `reload` / `restart` / `stop`), the route tables to drain, the whole nft
   ruleset and the whole `ip` command list.
3. **apply the plan.**

Converge's ordering constraints used to live only in comments (released links go down before anything comes up;
allocation precedes rendering; routing runs after the devices exist; the orphan sweep runs *here* not *there*),
with `Promise<void>` types saying none of it - one of them was restated in four places, which is what happens
when nothing enforces a rule. Now the order **is** the plan, and `wg/plan.test.ts` asserts it without a host.
The `restart` action exists for the one case a reload silently gets wrong: a just-provisioned exit link whose
name is still up from a crashed predecessor, where `wg syncconf` would apply the peers but not the new
`[Interface]` key and port.

This used to be a choice - `converge()` for peer/server config, `syncFirewall()` alone for pure policy changes -
decided by hand at ten call sites against a rule that lived only in a comment, where picking wrong was a silent
routing bug rather than a failing test. A policy-only mutation now also reloads the interface: that is a
`wg syncconf` with identical content, and it puts every nft rebuild on converge's serialized chain instead of
letting a policy handler race a concurrent converge. `tearDownExitLink()` is the one escape hatch, for the
peer-delete handler, which has to take an interface down whose describing row is about to disappear.

Failures are logged, not thrown: a `ConvergeResult` of `{ ok: false }` means the mutation was still applied and
persisted. Handlers `log.warn` and return 200. The host-wide half is applied **even when an interface step
failed** - a just-deleted peer has to lose its nft grants and its `ip rule` whether or not the interface came
back up.

### The wg/ layer: real vs. shim, and three independent capability axes

`src/wg/host.ts` declares `WgHost`, the interface every adapter at this seam implements, and the pure half of
the dispatch (`chooseHost`, `readShimOverride`, `capabilityRefusal`) - all of it tested in `wg/host.test.ts`.
`src/wg/shell.ts` does the io: it probes the host once at import time (top-level `await`) and picks between
`shell.real.ts` (actual `wg`/`wg-quick`/`ip`/`nft` invocations) and `shell.shim.ts` (in-memory fakes)
**per capability**, not as a single on/off switch:

| Axis | Probed by | Powers |
|---|---|---|
| `crypto` | `Bun.which('wg')` | `wgGenKey`/`wgGenPsk`/`wgDerivePublicKey` |
| `network` | `wg-quick`+`ip` present, and an actual `ip link add ... type dummy` probe (binaries can exist without `NET_ADMIN`) | `startInterface`/`reloadInterface`/`stopInterface`/`wgShow`/`isInterfaceUp`/`listInterfaces`/`applyExitRouting` |
| `firewall` | `nft` present and `nft list tables` actually succeeds | `applyFirewall`/`resetFirewall` |

In production (`NODE_ENV=production`), missing any capability throws on boot unless `WG_DEV_SHIM=true` is set
explicitly - it will not silently fall back to shimmed behavior. Outside production, each missing capability
logs a warning and shims just that axis.

**To add a function to this layer, add it to `WgHost` (`wg/host.ts`)** - `shell.ts` assigns each adapter's
module namespace to that type, so a missing or mistyped member in `shell.real.ts`/`shell.shim.ts` is a compile
error. This replaces a four-files-in-sync rule that nothing checked (and that two members had already drifted
from). The third adapter, `shell.recording.ts`, is the test one: it wraps a deterministic in-memory host with a
generic recorder, so *every* call is logged without a per-function list, and `src/tests/setup.ts` spreads its
`recordingHost` over the mocked module rather than re-exporting hand-written names. `shellCallLog` is how tests
assert that a mutation reloaded an interface or resynced policy - note it records reads (`isInterfaceUp`,
`listInterfaces`) too. Import it from `@server/wg/shell.recording`, not from `@server/wg/shell`.

Local dev/tests never need root or real WireGuard tooling: `WG_DEV_SHIM=true bun run dev` (or just running
outside a privileged container) exercises the full app against the shim.

### Restricted clients: tags, ordered grants, and the firewall as the actual boundary

Peers carry a many-to-many set of **tags** (`peerTagAssignmentsTable`; no tags is **fully unrestricted**, same
escape hatch the old single-`groupId` model had). Reachability is `policyGrantsTable`: an explicit, per-server
**ordered list** (`position`, ascending) of `(action: allow|deny, src: tag|peer, dst: tag|peer|cidr|server|any,
protocol, ports)` rows, evaluated first-match-wins - see the type comment atop `wg/firewall.ts` for
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
nanoid ids or `interfaceName`, because those don't satisfy nft's identifier charset; and a tag can't reach its own
members unless a grant explicitly names that tag as both `src` and `dst`.

**The hub is not an internet gateway.** `drizzle/0008_drop_hub_egress.sql` removed `serverPeers.enableNat` and
the `internet` grant destination: the ruleset has no nat hook, no masquerade and no `oifname`-based rule at all,
so a wg packet routed out a non-wg interface leaves with its vpn source address and nothing routes the reply
back. There is consequently no hub-side egress to permit, deny or guard - the only path to the internet is an
exit node peer (routing, `peers.exitPeerId`), whose traffic never leaves the wg interface on this host. The same
reason is why `allowedIpsForPeer` (`db/policyGraph.ts`) never widens to `0.0.0.0/0`: it used to for an
`internet`/`any` grant, and that hint would now route a client's internet traffic into a tunnel that drops it.
`?exit=true` is the one rendering that legitimately carries `/0`.

`src/wg/firewall.ts` exposes one function: `buildRuleset(fleet: PolicyGraph[])`, pure (no db, no io), taking the
fleet snapshot itself. It folds in the projection that resolves tags to member ips, decides which peers are
governed and drops unresolvable grants - that projection used to sit *above* this seam, which meant
`firewall.test.ts`'s fixtures re-enacted it by hand and nothing verified it. `wg/exitRouting.ts` is the same
shape (`buildExitRouting(fleet)`, plus a pure `buildExitRoutingChecks(fleet)` for the sysctl warnings).
Build `PolicyGraph` fixtures with `graphOf()` from `src/tests/graphs.ts`. Keep new test scenarios on the pure
function - `bun:sqlite` under
`NODE_ENV=test` is a single in-memory database shared across *all* test files in the same run, so anything
reading "all servers" from the db in a test would pick up fixtures inserted by unrelated test files (this is why
existing fixtures prefix ids per-file, e.g. `serversRouter-server`, `peersRouters-server`, `policyRouter-server`).

### Exit nodes: one wg interface each, and routing as the permission

A peer marked `peers.isExitNode` lends its own uplink to other clients: a peer with
`peers.exitPeerId` pointing at it gets a **second config rendering** (`?exit=true` on either
peer-config route) whose only difference is `AllowedIPs = 0.0.0.0/0, ::/0` - same key, same
address, same endpoint - so the client switches exit path by switching config file, with no
server-side state change, and repointing it at a *different* exit node changes nothing on the
client at all. The full traffic path and the rejected alternatives are in the top-of-file
comments on `wg/exitLinks.ts` (why an interface each) and `wg/exitRouting.ts` (how a client is
steered into one). The things most likely to surprise:

- **A server is several interfaces.** Its own, carrying every ordinary peer, plus one **exit
  link** per exit node - `wgx{n}`, allocated by `reconcileExitLinks` (`wg/exitLinks.ts`) and
  stored on the peer (`exitInterfaceName`/`exitPrivateKey`/`exitPublicKey`/`exitListenPort`/
  `exitRouteTableId`). An exit node is therefore *not* a peer of its server's interface, which
  is what `exitTopologyOf`'s `exitNodes`/`plainPeers` split exists to make impossible to
  forget. The reason is that wireguard picks the destination peer from the packet's
  destination address alone, so `0.0.0.0/0` has exactly one owner per interface - and writing
  it to a second peer silently *takes it away from the first* rather than failing.
- **Allocation is reconciled, never done in a write handler.** `converge()` calls
  `reconcileExitLinks` first, so a row that became an exit node by any path - the api, a policy
  import, a direct db write, or `drizzle/0009_exit_links.sql` landing on an install that
  already had one - gets provisioned on the next converge. Releasing works the same way, and
  the plan additionally stops `wgx`-shaped interfaces no peer claims (a peer deleted while the
  process was down) - *before* anything starts, so an orphan whose name is about to be reissued
  is gone first. A link that is reissued while still up is `restart`ed rather than reloaded,
  since `wg syncconf` would not apply its new key and port.
- **The `ip rule` is the permission, not the nft rule.** `wg/exitRouting.ts` installs
  `ip rule from <client>/32 table <that exit node's exitRouteTableId>` only for peers with an
  `exitPeerId`. Two clients of one server landing in two different tables, each with
  `default dev <that node's link>`, is the whole of "any peer can pick any exit node". Each
  table is a **complete** routing table, not just a default route: the client's rule captures
  *all* of its traffic, so the vpn subnet, every exit node's `/32` and every advertised prefix
  go in it too, or assigning an exit node would silently cut the client off from its peers.
- **An exit link is address-less and always `Table = off`.** Its peer owns `0.0.0.0/0`, which
  wg-quick would turn into a default route on the manager's own host. The exit node's `/32` is
  installed explicitly by `wg/exitRouting.ts` instead - its server's connected route no longer
  covers it - and an address here could only duplicate the server's (which the kernel refuses)
  or invent a link subnet.
- **Each exit link needs its own published UDP port**, since the exit node dials in. Allocated
  from 51900-51999 or pinned per peer (`exitListenPort`). This is the one operational cost of
  the design and the ui says so at every point where an exit node is configured.
- **Everything server-side can be correct and the client still times out**, because the two
  halves that are not in this codebase's control are the exit node's own machine
  (`ip_forward` + a masquerade rule, emitted only by the `?nat=true` rendering - and marking a
  peer as an exit node does *not* change its own config, though it *does* change which port and
  hub key that config must use, so the machine has to be re-provisioned by hand) and two host
  sysctls (`net.ipv4.ip_forward`, and `max(conf.all.rp_filter, conf.<iface>.rp_filter)` which
  must not be 1). `wg/exitRouting.ts` warns about both sysctls on every sync; nothing can
  detect the first.

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

Like `firewall.ts`, `exitRouting.ts` is pure - `buildExitRouting(fleet)` and
`buildExitRoutingChecks(fleet)`, which is what `exitRouting.test.ts` drives; converge applies
the commands at the *end* of the plan because `ip route ... dev <iface>` needs the device to
exist. Anything touching
`isExitNode`/`exitPeerId` changes the interface config too - which `converge()` handles, since it always applies
both the interface and the host-wide state.

### Frontend: no component library, one design system

`packages/app` is plain Vue 3 SFCs + Tailwind v4 utilities - **read `DESIGN.md` before touching any UI**. It
documents the "operator terminal console" system in detail (bracketed `[ action ]` buttons, `>` prompt glyphs,
`///` section markers, the `Base*` component set, the token palette in `src/assets/main.css`) and explicitly
lists what not to reach for (no PrimeVue/icon packages/second accent color - both were deliberately removed).
State: TanStack Vue Query for all server state (`src/queries/*.ts`, `queryOptions()` pattern), a single Pinia
store for the in-memory (non-persisted) auth token (`src/stores/auth.ts` - reloading the page logs you out by
design).

**Every write goes through `useWrite` (`src/queries/useWrite.ts`)** - it takes the eden call, the
`invalidate.*` fan-out from `queries/keys.ts` and a summary, and owns the rest: routing a field-scoped
`ApiError` onto the matching key of the form's `errors` object, and everything else to a toast (or, with
`report: 'inline'`, to `inlineError` - `PolicyJsonPanel.vue` is the one surface that wants that). Do not hand-roll
a `useMutation` here: the eleven write paths that predate this module each decided failure reporting
separately, and the three destructive ones (delete a peer, delete a tag, reset traffic) had decided on nothing,
failing as an unhandled rejection with no UI feedback at all.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`mkuhlmann/wgfleet`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: root `CONTEXT-MAP.md` plus a `CONTEXT.md` per package (`packages/app`, `packages/server`). See `docs/agents/domain.md`.
