ALTER TABLE "selfctl_chat_messages" ADD COLUMN "attachments" jsonb;--> statement-breakpoint
ALTER TABLE "selfctl_turns" ADD COLUMN "input_attachments" jsonb;