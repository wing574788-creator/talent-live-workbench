CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`entity` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_uq` ON `saved_views` (`entity`,`name`) WHERE "saved_views"."deleted_at" is null;