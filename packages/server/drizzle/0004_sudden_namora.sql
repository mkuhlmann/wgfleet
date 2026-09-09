CREATE TABLE `adminSessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `adminSessions_token_unique` ON `adminSessions` (`token`);--> statement-breakpoint
CREATE INDEX `adminSessions_token_idx` ON `adminSessions` (`token`);--> statement-breakpoint
CREATE INDEX `adminSessions_expiresAt_idx` ON `adminSessions` (`expiresAt`);