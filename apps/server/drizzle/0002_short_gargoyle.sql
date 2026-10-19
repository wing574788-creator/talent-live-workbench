CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`key` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_settings_uq` ON `app_settings` (`key`) WHERE "app_settings"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `enum_options` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`group` text NOT NULL,
	`value` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enum_options_uq` ON `enum_options` (`group`,`value`) WHERE "enum_options"."deleted_at" is null;