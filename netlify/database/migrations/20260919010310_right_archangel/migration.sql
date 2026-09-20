CREATE TABLE "selfctl_assets" (
	"id" text PRIMARY KEY,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
