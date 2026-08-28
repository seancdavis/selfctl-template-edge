import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
