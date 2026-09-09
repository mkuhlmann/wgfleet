# Context Map

## Contexts

- [Server](./packages/server/CONTEXT.md): manages WireGuard servers/peers, firewall policy, and traffic accounting
- App: Vue frontend for the Server context; no domain vocabulary of its own yet

## Relationships

- **App → Server**: the frontend imports the server's types and route contract directly (Eden Treaty over `typeof _app`), no separate client or shared schema package
