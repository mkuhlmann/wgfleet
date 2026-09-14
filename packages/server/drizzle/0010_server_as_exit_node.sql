-- The server itself as an exit node.
--
-- A peer exit node needs a wg interface of its own (drizzle/0009) because only one peer per
-- interface can own AllowedIPs 0.0.0.0/0. The *server* has no such problem: it is not a peer of
-- its own interface, so lending its own uplink costs no interface, no keypair and no extra udp
-- port - the client keeps dialing the endpoint it already dials.
--
-- `peers.exitViaServer` is the other arm of the choice `peers.exitPeerId` already expressed, so
-- the two are mutually exclusive (lib/peerInvariants.ts). Both default to off, and turning
-- `serverPeers.isExitNode` on grants nobody anything by itself: the masquerade is scoped to the
-- clients that actually selected it. That is deliberately unlike the `enableNat` this supersedes
-- (dropped in 0008), which needed a separate `internet` grant to agree with it - here, as with
-- peer exit nodes, the routing *is* the permission.
ALTER TABLE `peers` ADD `exitViaServer` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `serverPeers` ADD `isExitNode` integer DEFAULT false NOT NULL;