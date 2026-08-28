CREATE TABLE "selfctl_chat_messages" (
	"id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "selfctl_chat_threads" (
	"id" text PRIMARY KEY,
	"title" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "selfctl_config" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"connection_token" text,
	"model" text,
	"provider" text,
	CONSTRAINT "selfctl_config_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "selfctl_event_cursor" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"seq" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "selfctl_event_cursor_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "selfctl_events" (
	"seq" bigint PRIMARY KEY,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"turn_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "selfctl_proposals" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"turn_id" text,
	"thread_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "selfctl_scheduled_tasks" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "selfctl_turns" (
	"id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"input_text" text NOT NULL,
	"retry_attempt" integer DEFAULT 0 NOT NULL,
	"parent_proposal_id" text,
	"model" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_thread_id_chat_threads_id_fkey";--> statement-breakpoint
DROP TABLE "chat_messages";--> statement-breakpoint
DROP TABLE "chat_threads";--> statement-breakpoint
DROP TABLE "config";--> statement-breakpoint
DROP TABLE "events";--> statement-breakpoint
DROP TABLE "pending_proposals";--> statement-breakpoint
CREATE INDEX "selfctl_chat_messages_thread_created_idx" ON "selfctl_chat_messages" ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "selfctl_events_turn_id_idx" ON "selfctl_events" ("turn_id");--> statement-breakpoint
CREATE INDEX "selfctl_proposals_status_idx" ON "selfctl_proposals" ("status");--> statement-breakpoint
CREATE INDEX "selfctl_scheduled_tasks_status_run_at_idx" ON "selfctl_scheduled_tasks" ("status","run_at");--> statement-breakpoint
ALTER TABLE "selfctl_chat_messages" ADD CONSTRAINT "selfctl_chat_messages_thread_id_selfctl_chat_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "selfctl_chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "selfctl_turns" ADD CONSTRAINT "selfctl_turns_thread_id_selfctl_chat_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "selfctl_chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Hand-appended below the generated DDL: the two singleton rows the kit never
-- writes itself (kit README, "Database"). The event cursor is the `seq`
-- allocator every append locks and bumps; the config row is the single
-- settings row the kit reads before auth on every request. Drizzle generates
-- schema, not data, so these two INSERTs have to be carried by hand here — and
-- re-added by hand if this migration is ever regenerated.
--
-- The five DROP TABLEs above discard the old pre-kit tables and everything in
-- them. Data loss on the reference deploy is accepted (Sean, 2026-08-21).
INSERT INTO "selfctl_event_cursor" ("id", "seq") VALUES (1, 0);--> statement-breakpoint
INSERT INTO "selfctl_config" ("id") VALUES (1);