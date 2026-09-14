# Development

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

The frontend has no tests yet.

## Further reading

- [CLAUDE.md](../CLAUDE.md) — the architecture in detail.
- [DESIGN.md](../DESIGN.md) — read before touching the UI.
- [CONTEXT-MAP.md](../CONTEXT-MAP.md) — the bounded contexts and how they relate.
