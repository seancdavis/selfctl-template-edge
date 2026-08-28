import { defineProposalKind, type Skill, type Sql } from "@selfctl/agent-kit";
import { z } from "zod";

// The `reference.note` proposal kind: its payload is the note text, and
// `write` is the trusted-side effect that runs once a human approves (or
// overrides) the proposal — the kit's gate calls this inside a DB transaction.
const NotePayload = z.object({ text: z.string().min(1).max(4000) });

const noteProposalKind = defineProposalKind({
  kind: "reference.note",
  schema: NotePayload,
  write: async (sql: Sql, payload) => {
    await sql`INSERT INTO notes (text) VALUES (${payload.text})`;
  },
});

// The tool the model calls. It never writes anything itself — `rt.propose`
// just records a pending proposal; nothing lands in `notes` until a human
// approves it through `POST /agent/proposals/:id/decision`.
export const notesSkill: Skill = {
  name: "notes",
  proposals: [noteProposalKind],
  tools: (rt) => [
    {
      name: "createNote",
      description:
        "Propose saving a short note for later reference. This only creates a proposal — a human must approve it before anything is actually saved.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The note text to propose saving.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (args: unknown) => {
        const payload = NotePayload.parse(args);
        return rt.propose("reference.note", payload);
      },
    },
  ],
};
