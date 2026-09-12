-- Multiple exit nodes per server. An exit node no longer lives on its server's wg interface:
-- it gets a dedicated interface of its own on the hub (an "exit link"), because only one peer
-- can own AllowedIPs 0.0.0.0/0 on a given interface and wireguard picks the peer purely by the
-- packet's destination address. The five columns below are that interface; all are null unless
-- peers.isExitNode.
--
-- Existing exit nodes are deliberately *not* backfilled here - keys cannot be generated in SQL,
-- and an interface name/port/table has to be allocated against live state. reconcileExitLinks
-- (wg/exitLinks.ts) provisions any isExitNode row that has no link on the next converge, which
-- also covers rows that become exit nodes by a path that never goes through the api.
--
-- serverPeers.routeTableId goes with it: the policy-routing table now belongs to the exit node
-- (peers.exitRouteTableId), since the table's default route names one exit link. A per-server
-- table could only ever express one exit node.
ALTER TABLE `peers` ADD `exitInterfaceName` text;--> statement-breakpoint
ALTER TABLE `peers` ADD `exitPrivateKey` text;--> statement-breakpoint
ALTER TABLE `peers` ADD `exitPublicKey` text;--> statement-breakpoint
ALTER TABLE `peers` ADD `exitListenPort` integer;--> statement-breakpoint
ALTER TABLE `peers` ADD `exitRouteTableId` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `peers_exitInterfaceName_unique` ON `peers` (`exitInterfaceName`);--> statement-breakpoint
CREATE UNIQUE INDEX `peers_exitListenPort_unique` ON `peers` (`exitListenPort`);--> statement-breakpoint
CREATE UNIQUE INDEX `peers_exitRouteTableId_unique` ON `peers` (`exitRouteTableId`);--> statement-breakpoint
ALTER TABLE `serverPeers` DROP COLUMN `routeTableId`;