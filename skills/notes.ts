import { defineProposalKind, type Skill, type Sql } from "@selfctl/agent-kit";
import type { View } from "@selfctl/protocol";
import { z } from "zod";

// The `reference.note` proposal kind. `topic` is a short label the model picks;
// it exists so this skill has something worth remembering between turns (see
// `rememberTopic` below).
const NotePayload = z.object({
  text: z.string().min(1).max(4000),
  topic: z.string().min(1).max(80),
});

type NotePayload = z.infer<typeof NotePayload>;

async function insertNote(
  sql: Sql,
  payload: NotePayload,
  pinned: boolean,
): Promise<void> {
  await sql`INSERT INTO notes (text, pinned) VALUES (${payload.text}, ${pinned})`;
}

// A proposal kind can offer more than a yes/no. `write` is what a plain
// `approve` runs; each entry in `outcomes` is a separately named answer with
// its own writer, chosen by the button the human actually clicked.
//
// `skip` deliberately writes nothing. An outcome is allowed to be a pure
// decision: the gate still records the proposal as `resolved:skip` and stores
// the human's typed reason, so "no, and here's why" stays real signal in the
// event log instead of vanishing.
//
// What an outcome does NOT carry is its label — that lives in the view below.
// The kind owns behaviour, the view owns presentation, and the kit checks at
// propose time that every outcome named by a view actually exists here.
const noteProposalKind = defineProposalKind({
  kind: "reference.note",
  schema: NotePayload,
  write: async (sql, payload) => {
    await insertNote(sql, payload, false);
  },
  outcomes: {
    save: savingOutcome(false),
    pin: savingOutcome(true),
    skip: { write: async () => {} },
  },
});

function savingOutcome(pinned: boolean) {
  return {
    write: (sql: Sql, payload: NotePayload) => insertNote(sql, payload, pinned),
  };
}

// How this proposal should look. A view is composed from a fixed set of
// primitives — stack, text, image, keyValue, badge, actions, link — and every
// value in it is literal, because the agent already knows the text when it
// builds the card. There is no template language and nothing to interpolate
// later. A client renders this without knowing anything about notes; one that
// meets a primitive from a newer protocol version drops that node and still
// renders its siblings.
function noteProposalView(payload: NotePayload): View {
  return {
    type: "stack",
    direction: "vertical",
    children: [
      { type: "text", value: "Save this note?", style: "heading" },
      { type: "text", value: payload.text, style: "body" },
      { type: "badge", label: payload.topic },
      {
        type: "actions",
        items: [
          { label: "Save", outcome: "save" },
          { label: "Save & pin", outcome: "pin" },
          // `note: "prompt"` makes the client collect a reason before it
          // dispatches this outcome, and the gate stores it on the proposal.
          { label: "Skip", outcome: "skip", note: "prompt" },
        ],
      },
    ],
  };
}

interface NoteRow {
  id: string;
  text: string;
  pinned: boolean;
  createdAt: Date;
}

// The same vocabulary describes an inline chat component. Note the repetition
// is unrolled here rather than expressed as a loop: there is no `list`
// primitive, because the agent is the thing holding the array and can simply
// emit one sub-tree per row.
function noteListView(notes: NoteRow[]): View {
  return {
    type: "stack",
    direction: "vertical",
    children: [
      {
        type: "text",
        value: notes.length === 1 ? "1 saved note" : `${notes.length} saved notes`,
        style: "heading",
      },
      ...notes.map(
        (note): View => ({
          type: "stack",
          direction: "vertical",
          children: [
            { type: "text", value: note.text, style: "body" },
            ...(note.pinned
              ? [{ type: "badge", label: "pinned" } as View]
              : []),
            {
              type: "text",
              value: note.createdAt.toISOString().slice(0, 10),
              style: "muted",
            },
          ],
        }),
      ),
    ],
  };
}

const MEMORY_HEADING = "Topics I have already proposed notes about:";
const MAX_REMEMBERED_TOPICS = 40;

// `rt.memory` is the one write here that does NOT go through the gate — and
// that is only true because it is not a domain write. It is a single free-form
// document, private to this agent, that the kit puts in front of the model on
// every turn. Use it for what the agent concluded, never for what it did: a
// fact that other code or another agent would read belongs in a proposal and a
// real table, and routing it through memory would walk around the approval
// contract by the back door.
//
// Here it stops the agent proposing the same topic twice. Pruning is the
// agent's job (there is a 64KB ceiling and a write above it throws), which is
// why this trims to the most recent entries.
async function rememberTopic(
  memory: { read(): Promise<string>; write(text: string): Promise<void> },
  topic: string,
): Promise<void> {
  const existing = await memory.read();
  const topics = existing
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line !== "" && line !== MEMORY_HEADING);

  if (topics.some((seen) => seen.toLowerCase() === topic.toLowerCase())) return;

  const next = [topic, ...topics].slice(0, MAX_REMEMBERED_TOPICS);
  await memory.write(
    [MEMORY_HEADING, ...next.map((entry) => `- ${entry}`)].join("\n"),
  );
}

// The tools the model calls. Neither writes to a domain table: `rt.propose`
// records a pending proposal and nothing lands in `notes` until a human picks
// an outcome, and `rt.db` is a read handle enforced by a read-only database
// transaction, so a stray INSERT there fails rather than quietly succeeding.
export const notesSkill: Skill = {
  name: "notes",
  proposals: [noteProposalKind],
  tools: (rt) => [
    {
      name: "createNote",
      description:
        "Propose saving a short note for later reference. This only creates a proposal — a human chooses whether to save it, save and pin it, or skip it.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The note text to propose saving.",
          },
          topic: {
            type: "string",
            description:
              "A short subject label for this note, a few words at most. Check your memory first and do not propose a topic you have already proposed.",
          },
        },
        required: ["text", "topic"],
        additionalProperties: false,
      },
      execute: async (args: unknown) => {
        const payload = NotePayload.parse(args);
        const proposal = await rt.propose(
          "reference.note",
          payload,
          noteProposalView(payload),
        );
        // Recorded whether or not the human ever answers the card. That is the
        // point: a suggestion nobody responds to is still something the agent
        // needs to know it made.
        await rememberTopic(rt.memory, payload.topic);
        return proposal;
      },
    },
    {
      name: "listNotes",
      description:
        "List the notes that have actually been saved. This reflects what a human approved — not what has merely been proposed.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        const rows = await rt.db<
          { id: string; text: string; pinned: boolean; created_at: Date }[]
        >`
          SELECT id, text, pinned, created_at FROM notes
          ORDER BY pinned DESC, created_at DESC LIMIT 20
        `;
        const notes: NoteRow[] = rows.map((row) => ({
          id: row.id,
          text: row.text,
          pinned: row.pinned,
          createdAt: row.created_at,
        }));
        // The payload is the data; the view is how to draw it. A client that
        // has no renderer for this kind now falls back to a readable card
        // built from the payload rather than showing nothing.
        rt.emit("reference.note-list", { notes }, noteListView(notes));
        return notes;
      },
    },
  ],
};
