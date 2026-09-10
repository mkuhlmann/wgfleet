ALTER TABLE `peers` ADD `isExitNode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `peers` ADD `exitPeerId` text REFERENCES peers(id);--> statement-breakpoint
ALTER TABLE `peers` ADD `exitDns` text;--> statement-breakpoint
ALTER TABLE `serverPeers` ADD `dns` text;--> statement-breakpoint
ALTER TABLE `serverPeers` ADD `routeTableId` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- sqlite's ALTER TABLE ADD COLUMN refuses a non-constant default on a table that already
-- has rows, so the literal `0` above lets the column be added and this backfills existing
-- servers to distinct ids in the same 52000.. band db/servers.ts's allocateRouteTableId
-- allocates from (see drizzle/0003_futuristic_black_knight.sql for the same pattern).
UPDATE `serverPeers` SET `routeTableId` = 52000 + (SELECT COUNT(*) FROM `serverPeers` AS `s2` WHERE `s2`.`rowid` < `serverPeers`.`rowid`);
