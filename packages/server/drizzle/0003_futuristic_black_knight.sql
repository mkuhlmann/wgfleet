CREATE TABLE `trafficBuckets` (
	`id` text PRIMARY KEY NOT NULL,
	`peerId` text NOT NULL,
	`serverPeerId` text NOT NULL,
	`resolution` text NOT NULL,
	`bucketStart` integer NOT NULL,
	`rxBytes` integer DEFAULT 0 NOT NULL,
	`txBytes` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`peerId`) REFERENCES `peers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`serverPeerId`) REFERENCES `serverPeers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trafficBuckets_server_res_bucket_idx` ON `trafficBuckets` (`serverPeerId`,`resolution`,`bucketStart`);--> statement-breakpoint
CREATE UNIQUE INDEX `trafficBuckets_peerId_resolution_bucketStart_unique` ON `trafficBuckets` (`peerId`,`resolution`,`bucketStart`);--> statement-breakpoint
ALTER TABLE `peers` ADD `wgLastRxBytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `peers` ADD `wgLastTxBytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `peers` ADD `wgLastSampledAt` integer;--> statement-breakpoint
ALTER TABLE `peers` ADD `lifetimeRxBytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `peers` ADD `lifetimeTxBytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `peers` ADD `statsSince` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `serverPeers` ADD `lifetimeRxBytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `serverPeers` ADD `lifetimeTxBytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `serverPeers` ADD `statsSince` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `peers` SET `statsSince` = unixepoch() WHERE `statsSince` = 0;--> statement-breakpoint
UPDATE `serverPeers` SET `statsSince` = unixepoch() WHERE `statsSince` = 0;