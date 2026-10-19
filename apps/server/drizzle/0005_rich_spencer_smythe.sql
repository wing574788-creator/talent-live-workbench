CREATE TABLE `ai_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`title` text NOT NULL,
	`file` text,
	`transcript` text DEFAULT '[]' NOT NULL
);
