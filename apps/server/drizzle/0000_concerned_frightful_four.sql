CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`original_name` text,
	`mime` text,
	`size_bytes` integer,
	`owner_type` text
);
--> statement-breakpoint
CREATE TABLE `change_log` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before` text,
	`after` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`batch_id` text,
	`approved_by` text,
	`undo_of` text,
	`reverted_at` text,
	`source` text
);
--> statement-breakpoint
CREATE INDEX `change_log_entity_idx` ON `change_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `change_log_batch_idx` ON `change_log` (`batch_id`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`org` text,
	`wechat` text,
	`phone` text,
	`custom` text
);
--> statement-breakpoint
CREATE TABLE `cooperation_products` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`cooperation_id` text NOT NULL,
	`product_id` text NOT NULL,
	`commission_pct` real,
	`live_price_cents` integer,
	`mechanism` text
);
--> statement-breakpoint
CREATE TABLE `cooperations` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`influencer_id` text NOT NULL,
	`platform_account_id` text NOT NULL,
	`contact_id` text,
	`mode` text DEFAULT '纯佣' NOT NULL,
	`stage` text DEFAULT '待建联' NOT NULL,
	`follow_status` text,
	`follow_count` integer DEFAULT 0 NOT NULL,
	`payment_status` text,
	`slot_fee_cents` integer,
	`live_date` text,
	`live_slot` text,
	`link_method` text,
	`next_follow_date` text,
	`lost_reason` text,
	`channel` text,
	`report_status` text,
	`custom` text
);
--> statement-breakpoint
CREATE INDEX `cooperations_influencer_idx` ON `cooperations` (`influencer_id`);--> statement-breakpoint
CREATE INDEX `cooperations_stage_idx` ON `cooperations` (`stage`);--> statement-breakpoint
CREATE INDEX `cooperations_next_follow_idx` ON `cooperations` (`next_follow_date`);--> statement-breakpoint
CREATE TABLE `field_defs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`entity` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`options` text,
	`sensitive` integer DEFAULT false NOT NULL,
	`allow_outbound` integer DEFAULT false NOT NULL,
	`indexed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_defs_uq` ON `field_defs` (`entity`,`key`) WHERE "field_defs"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `follow_ups` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`occurred_at` text NOT NULL,
	`method` text NOT NULL,
	`cooperation_id` text,
	`influencer_id` text,
	`contact_id` text,
	`summary` text NOT NULL,
	`intent` text,
	`follow_status` text,
	`next_action` text,
	`next_follow_date` text,
	`source_text` text,
	`source_attachment_id` text
);
--> statement-breakpoint
CREATE INDEX `follow_ups_coop_idx` ON `follow_ups` (`cooperation_id`);--> statement-breakpoint
CREATE INDEX `follow_ups_influencer_idx` ON `follow_ups` (`influencer_id`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`file_name` text,
	`entity` text,
	`template_id` text,
	`status` text DEFAULT 'committed' NOT NULL,
	`stats` text,
	`rolled_back_at` text
);
--> statement-breakpoint
CREATE TABLE `influencer_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`influencer_id` text NOT NULL,
	`recipient` text NOT NULL,
	`phone` text,
	`address` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `influencer_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`influencer_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `influencer_contacts_uq` ON `influencer_contacts` (`influencer_id`,`contact_id`) WHERE "influencer_contacts"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `influencers` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`nickname` text NOT NULL,
	`real_name` text,
	`category_tags` text,
	`style_tags` text,
	`coop_preference` text,
	`ref_commission_pct` real,
	`ref_quote_cents` integer,
	`ref_updated_at` text,
	`ref_source` text,
	`rating` text,
	`blacklist_reason` text,
	`recycle_issue_count` integer DEFAULT 0 NOT NULL,
	`custom` text
);
--> statement-breakpoint
CREATE TABLE `mapping_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`name` text NOT NULL,
	`entity` text NOT NULL,
	`header_signature` text NOT NULL,
	`mapping` text NOT NULL,
	`transforms` text,
	`enum_map` text
);
--> statement-breakpoint
CREATE TABLE `outbound_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`model` text NOT NULL,
	`module` text,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outbound_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pending_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`patch` text,
	`before` text,
	`base_version` integer NOT NULL,
	`reason` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`batch_id` text,
	`source` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_at` text,
	`reviewed_by` text
);
--> statement-breakpoint
CREATE INDEX `pending_changes_status_idx` ON `pending_changes` (`status`);--> statement-breakpoint
CREATE TABLE `platform_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`influencer_id` text NOT NULL,
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`profile_url` text,
	`role` text,
	`followers` integer,
	`avg_views` integer,
	`avg_sales_min_cents` integer,
	`avg_sales_max_cents` integer,
	`stats_date` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_accounts_uq` ON `platform_accounts` (`platform`,`account_id`) WHERE "platform_accounts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `platform_accounts_influencer_idx` ON `platform_accounts` (`influencer_id`);--> statement-breakpoint
CREATE TABLE `product_images` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`product_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_platform_links` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`product_id` text NOT NULL,
	`platform` text NOT NULL,
	`platform_product_id` text,
	`url` text
);
--> statement-breakpoint
CREATE TABLE `product_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`product_id` text NOT NULL,
	`color` text NOT NULL,
	`size` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_uq` ON `product_variants` (`product_id`,`color`,`size`) WHERE "product_variants"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`style_no` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT '在售' NOT NULL,
	`daily_price_cents` integer,
	`live_price_cents` integer,
	`final_price_cents` integer,
	`price_1111_cents` integer,
	`price_618_cents` integer,
	`mechanism` text,
	`size_chart` text,
	`size_chart_image_id` text,
	`selling_points` text,
	`custom` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_style_no_uq` ON `products` (`style_no`) WHERE "products"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `sample_return_items` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`return_id` text NOT NULL,
	`style_no` text NOT NULL,
	`product_name` text NOT NULL,
	`color` text NOT NULL,
	`size` text NOT NULL,
	`qty` integer NOT NULL,
	`qa_result` text,
	`photo_attachment_ids` text,
	`disposition` text
);
--> statement-breakpoint
CREATE INDEX `sample_return_items_return_idx` ON `sample_return_items` (`return_id`);--> statement-breakpoint
CREATE TABLE `sample_returns` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`influencer_id` text NOT NULL,
	`returned_at` text NOT NULL,
	`carrier` text,
	`tracking_no` text
);
--> statement-breakpoint
CREATE INDEX `sample_returns_influencer_idx` ON `sample_returns` (`influencer_id`);--> statement-breakpoint
CREATE TABLE `sample_shipment_items` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`shipment_id` text NOT NULL,
	`product_id` text,
	`style_no` text NOT NULL,
	`product_name` text NOT NULL,
	`color` text NOT NULL,
	`size` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_value_cents` integer
);
--> statement-breakpoint
CREATE INDEX `sample_shipment_items_shipment_idx` ON `sample_shipment_items` (`shipment_id`);--> statement-breakpoint
CREATE TABLE `sample_shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`influencer_id` text NOT NULL,
	`cooperation_id` text,
	`recipient` text,
	`phone` text,
	`address` text,
	`status` text DEFAULT '待寄样' NOT NULL,
	`shipped_at` text,
	`carrier` text,
	`tracking_no` text,
	`signed_at` text,
	`due_back_date` text
);
--> statement-breakpoint
CREATE INDEX `sample_shipments_influencer_idx` ON `sample_shipments` (`influencer_id`);--> statement-breakpoint
CREATE TABLE `sample_writeoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`influencer_id` text NOT NULL,
	`style_no` text NOT NULL,
	`product_name` text NOT NULL,
	`color` text NOT NULL,
	`size` text NOT NULL,
	`qty` integer NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sample_writeoffs_influencer_idx` ON `sample_writeoffs` (`influencer_id`);--> statement-breakpoint
CREATE TABLE `summary_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`day` text NOT NULL,
	`kind` text DEFAULT 'home' NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `summary_cache_uq` ON `summary_cache` (`day`,`kind`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`owner_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL
);
