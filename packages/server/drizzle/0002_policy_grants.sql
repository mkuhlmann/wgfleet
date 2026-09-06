CREATE TABLE `peerTags` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`serverPeerId` text NOT NULL,
	`name` text NOT NULL,
	`friendlyName` text,
	FOREIGN KEY (`serverPeerId`) REFERENCES `serverPeers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peerTags_serverPeerId_name_unique` ON `peerTags` (`serverPeerId`,`name`);
--> statement-breakpoint
CREATE TABLE `peerTagAssignments` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` integer NOT NULL,
	`peerId` text NOT NULL,
	`tagId` text NOT NULL,
	FOREIGN KEY (`peerId`) REFERENCES `peers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tagId`) REFERENCES `peerTags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peerTagAssignments_peerId_tagId_unique` ON `peerTagAssignments` (`peerId`,`tagId`);
--> statement-breakpoint
CREATE TABLE `policyGrants` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`serverPeerId` text NOT NULL,
	`position` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`action` text NOT NULL,
	`srcKind` text NOT NULL,
	`srcTagId` text,
	`srcPeerId` text,
	`dstKind` text NOT NULL,
	`dstTagId` text,
	`dstPeerId` text,
	`dstCidr` text,
	`protocol` text DEFAULT 'any' NOT NULL,
	`ports` text,
	`comment` text,
	FOREIGN KEY (`serverPeerId`) REFERENCES `serverPeers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`srcTagId`) REFERENCES `peerTags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`srcPeerId`) REFERENCES `peers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dstTagId`) REFERENCES `peerTags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dstPeerId`) REFERENCES `peers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Data migration: carry the existing groups/rules model forward as tags/grants, reusing each
-- group's id as its tag's id so peers.groupId (still populated at this point) can be copied
-- straight into peerTagAssignments with no lookup. Every migrated grant is `allow` - the old
-- model had no deny/ordering concept, so relative position among these has no behavioural
-- effect (see wg/firewall.ts) and is only kept distinct for a stable display order.
INSERT INTO `peerTags` (`id`, `createdAt`, `updatedAt`, `serverPeerId`, `name`, `friendlyName`)
	SELECT `id`, `createdAt`, `updatedAt`, `serverPeerId`, `name`, `friendlyName` FROM `peerGroups`;
--> statement-breakpoint
INSERT INTO `peerTagAssignments` (`id`, `createdAt`, `peerId`, `tagId`)
	SELECT lower(hex(randomblob(16))), unixepoch(), `id`, `groupId` FROM `peers` WHERE `groupId` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `policyGrants` (`id`, `createdAt`, `updatedAt`, `serverPeerId`, `position`, `enabled`, `action`, `srcKind`, `srcTagId`, `dstKind`, `dstTagId`, `dstCidr`, `protocol`)
	SELECT
		lower(hex(randomblob(16))),
		unixepoch(),
		unixepoch(),
		g.`serverPeerId`,
		row_number() OVER (PARTITION BY g.`serverPeerId` ORDER BY r.`createdAt`, r.`id`) - 1,
		1,
		'allow',
		'tag',
		r.`srcGroupId`,
		CASE WHEN r.`dstGroupId` IS NOT NULL THEN 'tag' ELSE 'cidr' END,
		r.`dstGroupId`,
		r.`dstCidr`,
		'any'
	FROM `peerGroupRules` r JOIN `peerGroups` g ON g.`id` = r.`srcGroupId`;
--> statement-breakpoint
-- old `allowServer` boolean -> an explicit `allow tag:<group> -> server` grant
INSERT INTO `policyGrants` (`id`, `createdAt`, `updatedAt`, `serverPeerId`, `position`, `enabled`, `action`, `srcKind`, `srcTagId`, `dstKind`, `protocol`)
	SELECT
		lower(hex(randomblob(16))),
		unixepoch(),
		unixepoch(),
		`serverPeerId`,
		10000 + row_number() OVER (PARTITION BY `serverPeerId` ORDER BY `id`),
		1,
		'allow',
		'tag',
		`id`,
		'server',
		'any'
	FROM `peerGroups` WHERE `allowServer` = 1;
--> statement-breakpoint
-- old `allowInternet` boolean -> an explicit `allow tag:<group> -> internet` grant
INSERT INTO `policyGrants` (`id`, `createdAt`, `updatedAt`, `serverPeerId`, `position`, `enabled`, `action`, `srcKind`, `srcTagId`, `dstKind`, `protocol`)
	SELECT
		lower(hex(randomblob(16))),
		unixepoch(),
		unixepoch(),
		`serverPeerId`,
		20000 + row_number() OVER (PARTITION BY `serverPeerId` ORDER BY `id`),
		1,
		'allow',
		'tag',
		`id`,
		'internet',
		'any'
	FROM `peerGroups` WHERE `allowInternet` = 1;
--> statement-breakpoint
DROP TABLE `peerGroupRules`;
--> statement-breakpoint
DROP TABLE `peerGroups`;
--> statement-breakpoint
ALTER TABLE `peers` DROP COLUMN `groupId`;
