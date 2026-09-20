import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// The kit's tables (`selfctl_*`: the event log and its cursor, proposals, chat
// threads/messages, turns, scheduled tasks, config) come from the kit as
// Drizzle definitions only — it ships no migrations of its own. Re-exporting
// them here is what puts them in front of `drizzle-kit generate`, so this
// fork's own `netlify/database/migrations/` stays the single source of truth
// for the deployed database. Upgrading the kit is: `npm i @selfctl/agent-kit@latest`
// → `npm run db:generate` → commit the migration.
export * from "@selfctl/agent-kit/db";

// The fork's domain tables live alongside them, un-prefixed. This one is the
// `reference.note` proposal kind's write target (see `skills/notes.ts`): once a
// proposal is approved or overridden, its `write()` lands a row here.
export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  text: text("text").notNull(),
  // Set by the `pin` outcome rather than by plain approval — see `skills/notes.ts`.
  // A proposal kind can declare several named outcomes, each with its own writer,
  // so one card can offer more than a yes/no.
  pinned: boolean("pinned").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  sourceUrl: text("source_url"),
  // Where `source_url` is a page the note came from, this is a URL pointing
  // directly at a picture — see `skills/notes.ts` for why these are two
  // separate, independent fields rather than one guessed apart by shape.
  imageUrl: text("image_url"),
  imageAssetId: text("image_asset_id"),
});

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
