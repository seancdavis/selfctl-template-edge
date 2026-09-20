import { GoogleGenAI } from "@google/genai";
import {
  defineMutation,
  defineProposalKind,
  enqueueScheduledTask,
  type Skill,
  type Sql,
  type TaskHandlerDef,
  type WidgetProducer,
} from "@selfctl/agent-kit";
import type { View } from "@selfctl/protocol";
import { z } from "zod";

// A URL that arrives through a tool argument is untrusted, and it ends up in
// a link the client renders or an image it fetches — so it has to be
// credential-free http/https, nothing else.
const httpUrlNoCredentials = z.string().refine((value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === ""
  );
}, "must be an http(s) URL with no embedded credentials");

// The `reference.note` proposal kind. `topic` is a short label the model picks;
// it exists so this skill has something worth remembering between turns (see
// `rememberTopic` below).
//
// `sourceUrl` and `imageUrl` are separate, independently optional fields —
// not one field the code guesses at. A URL's shape cannot tell you what it
// points to: a CDN image URL (Unsplash, Cloudinary, Netlify's own Image CDN)
// routinely carries no file extension at all once resize/format query
// parameters are in play, so sniffing the string can't classify it and no
// amount of regex-tightening fixes that. The model already knows which one
// it has from context, so it says so directly.
const NotePayload = z.object({
  text: z.string().min(1).max(4000),
  topic: z.string().min(1).max(80),
  sourceUrl: httpUrlNoCredentials.optional(),
  imageUrl: httpUrlNoCredentials.optional(),
});

type NotePayload = z.infer<typeof NotePayload>;

async function insertNote(
  sql: Sql,
  payload: NotePayload,
  pinned: boolean,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO notes (text, pinned, source_url, image_url)
    VALUES (${payload.text}, ${pinned}, ${payload.sourceUrl ?? null}, ${payload.imageUrl ?? null})
    RETURNING id
  `;
  return row.id;
}

const AUTO_UNPIN_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

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
    save: {
      write: async (sql: Sql, payload: NotePayload) => {
        await insertNote(sql, payload, false);
      },
    },
    // `pin` is the only outcome that also queues `notes.autoUnpin`, seven
    // days out, in the same transaction as the insert — the note is pinned
    // and the chore to undo that exists atomically, or neither does. `save`
    // never pins, so it has nothing for that chore to undo.
    pin: {
      write: async (sql: Sql, payload: NotePayload) => {
        const id = await insertNote(sql, payload, true);
        await enqueueScheduledTask(sql, {
          kind: "notes.autoUnpin",
          payload: { noteId: id },
          runAt: new Date(Date.now() + AUTO_UNPIN_DELAY_MS),
        });
      },
    },
    skip: { write: async () => {} },
  },
});

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
      // A plain `link` here is enough for the human deciding whether to
      // approve — no need to preview an image before the note even exists.
      ...(payload.sourceUrl
        ? [{ type: "link", href: payload.sourceUrl, label: "Source" } as View]
        : []),
      // Unlike `sourceUrl`, an `imageUrl` picture is exactly what the human
      // is being asked to approve, so the card shows it rather than just
      // naming it.
      ...(payload.imageUrl
        ? [{ type: "image", src: payload.imageUrl, alt: "Note image" } as View]
        : []),
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

// A second proposal kind, shaped like `noteProposalKind` above: the model can
// generate something, but only a human's approval makes it real. Unlike
// `reference.note`, this one needs no named outcomes — attach the image or
// don't, there is no equivalent of "save and pin" for a picture.
//
// The kind's last dot-separated segment is not decorative: the desktop app
// builds a proposal card's heading by taking it and prefixing "wants to", so
// this reads as "wants to attach" in the client. Name a kind with that in
// mind — the noun this kind used to end in made the same card read "wants
// to image", which is not a verb.
const NoteImagePayload = z.object({
  noteId: z.string(),
  assetId: z.string(),
});

type NoteImagePayload = z.infer<typeof NoteImagePayload>;

const noteImageProposalKind = defineProposalKind({
  kind: "reference.note.attach",
  schema: NoteImagePayload,
  write: async (sql, payload) => {
    await sql`
      UPDATE notes SET image_asset_id = ${payload.assetId} WHERE id = ${payload.noteId}
    `;
  },
});

// Same reasoning as `noteProposalView`: every value here is literal, already
// known by the time the tool that builds this view has run. The `asset` node
// carries only the id `rt.assets.put` returned — never a URL, because there
// isn't one to carry. A client resolves that id with its own bearer against
// `GET /assets/:id`; nothing about the id does anything without that token,
// which is the whole reason this is `asset` and not `image`.
function noteImageProposalView(payload: NoteImagePayload): View {
  return {
    type: "stack",
    direction: "vertical",
    children: [
      {
        type: "text",
        value: "Attach this generated image to the note?",
        style: "heading",
      },
      { type: "asset", id: payload.assetId, alt: "Generated feature image" },
    ],
  };
}

interface NoteRow {
  id: string;
  text: string;
  pinned: boolean;
  sourceUrl: string | null;
  imageUrl: string | null;
  imageAssetId: string | null;
  createdAt: Date;
}

// A mutation is a write with no approval card, because the person clicking
// the button is already the trusted actor — the card only reaches them
// through their own view of this agent. The kit only checks that `kind`
// names a mutation registered below; it has no way to check that a `payload`
// or `confirm` came from somewhere trustworthy, so that part is on whoever
// builds the view: a mutation's `kind` and `payload` must come from the
// skill's own reads, never from a tool argument, and the `mutations` node
// carrying them must never appear on a proposal's view, which is still
// waiting for a human's decision (see `noteListView`).
const notesDeleteMutation = defineMutation({
  kind: "notes.delete",
  schema: z.object({ id: z.string() }),
  write: async (sql, payload) => {
    await sql`DELETE FROM notes WHERE id = ${payload.id}`;
  },
});

const notesUnpinMutation = defineMutation({
  kind: "notes.unpin",
  schema: z.object({ id: z.string() }),
  write: async (sql, payload) => {
    await sql`UPDATE notes SET pinned = false WHERE id = ${payload.id}`;
  },
});

// Pinning something forever is a chore a human would otherwise have to
// remember to undo — this is exactly the deterministic, no-model work the
// tick exists for. It is the `notes.unpin` mutation above made by a clock
// instead of a click, so the write is the same one-line UPDATE. The `AND
// pinned` guard is what makes "clears it if it is still pinned" true without
// a separate read: a note unpinned or deleted by hand in the intervening
// week just makes this a no-op, not an error.
const autoUnpinHandler: TaskHandlerDef = {
  kind: "notes.autoUnpin",
  handle: async (sql, payload) => {
    const { noteId } = z.object({ noteId: z.string() }).parse(payload);
    await sql`UPDATE notes SET pinned = false WHERE id = ${noteId} AND pinned`;
  },
};

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
            // `link` and `image` are independent nodes now, not a guess
            // branching on one field's shape — a note may carry a source
            // page, a picture, both, or neither.
            ...(note.sourceUrl
              ? [{ type: "link", href: note.sourceUrl, label: "Source" } as View]
              : []),
            ...(note.imageUrl
              ? [{ type: "image", src: note.imageUrl, alt: "Note image" } as View]
              : []),
            // `image` points at a URL that is already public on the internet,
            // so any client fetches it directly. `asset` instead carries an
            // id that only a bearer token can resolve. That distinction is
            // the whole reason both nodes exist, and with `imageUrl` and the
            // generated `imageAssetId` able to sit on the same note, this
            // template shows a public picture and a private one side by
            // side. Only an id ever reaches the node below — see
            // `noteImageProposalView` for why that is the entire point of
            // `asset` over `image`.
            ...(note.imageAssetId
              ? [
                  {
                    type: "asset",
                    id: note.imageAssetId,
                    alt: "Generated feature image",
                  } as View,
                ]
              : []),
            {
              type: "text",
              value: note.createdAt.toISOString().slice(0, 10),
              style: "muted",
            },
            // `note.id` comes from the row this skill just selected out of
            // its own table, never from a tool argument — that is what makes
            // it safe to hand to a mutation. This node lives only on the
            // emitted list card, never on `noteProposalView`: agent-kit 0.8.0
            // refuses a proposal view carrying a `mutations` node outright,
            // because a write that skips approval has no business sitting on
            // a card still waiting for a human's decision.
            {
              type: "mutations",
              items: [
                ...(note.pinned
                  ? [
                      {
                        label: "Unpin",
                        kind: "notes.unpin",
                        payload: { id: note.id },
                      },
                    ]
                  : []),
                {
                  label: "Delete",
                  kind: "notes.delete",
                  payload: { id: note.id },
                  // Deleting a note cannot be undone, so this outcome carries
                  // real confirm text — the app turns any non-empty confirm
                  // into a two-press button, and unpinning does not need one.
                  confirm: "Delete this note? This cannot be undone.",
                },
              ],
            },
          ],
        }),
      ),
    ],
  };
}

// A widget is the one thing here with no model in the loop: the kit runs
// `produce` straight against the database on a schedule the dashboard
// controls, not in response to a tool call. `count(*) FILTER (WHERE ...)`
// gets all three totals from one pass over `notes` rather than three
// round trips. Postgres hands count(*) back as a string through this
// driver, so every value gets coerced to a number before it is compared
// or rendered.
const notesStatsWidget: WidgetProducer = {
  id: "notes-stats",
  componentKind: "reference.notes-stats",
  title: "Notes",
  produce: async (db: Sql) => {
    const [row] = await db<
      { total: string; pinned: string; with_image: string }[]
    >`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE pinned) AS pinned,
        count(*) FILTER (WHERE image_asset_id IS NOT NULL) AS with_image
      FROM notes
    `;
    const total = Number(row.total);
    // A fresh fork's `notes` table is empty. A card reporting three zeroes
    // teaches a reader nothing, so the widget hides itself instead of
    // rendering one.
    if (total === 0) return null;
    return {
      total,
      pinned: Number(row.pinned),
      withImage: Number(row.with_image),
    };
  },
  // `payload` arrives as `unknown` because the kit stores and forwards it
  // without knowing its shape — only this function does. The producer's
  // own `title` already labels the card, so the numbers alone are the
  // whole view.
  view: (payload) => {
    const stats = payload as { total: number; pinned: number; withImage: number };
    return {
      type: "keyValue",
      items: [
        { label: "Total", value: String(stats.total) },
        { label: "Pinned", value: String(stats.pinned) },
        { label: "With image", value: String(stats.withImage) },
      ],
    };
  },
};

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

// Picked by checking the AI Gateway's live model list at implementation time
// (docs.netlify.com/build/ai-gateway/overview's "Model availability" table),
// not copied from a prior run or from memory — that list changes, and a
// stale id here would fail at call time, invisibly to `npm run typecheck`.
// The `-image` suffix is Google's marker for a model that can return inline
// image bytes rather than only text; the `flash` tier is the cheap, fast one
// among the currently served image models, which suits a demo generation
// better than the heavier `-pro-image` sibling.
const IMAGE_MODEL = "gemini-3.1-flash-image";

// The tools the model calls. None of them writes to a domain table directly:
// `rt.propose` records a pending proposal and nothing lands in `notes` until
// a human picks an outcome; `rt.db` is a read handle enforced by a read-only
// database transaction, so a stray INSERT there fails rather than quietly
// succeeding; and `rt.assets.put` stores bytes with no proposal at all,
// because an unreferenced asset can't yet affect anything the gate protects
// (see `noteImageProposalView` for what makes it reachable).
export const notesSkill: Skill = {
  name: "notes",
  proposals: [noteProposalKind, noteImageProposalKind],
  mutations: [notesDeleteMutation, notesUnpinMutation],
  widgets: [notesStatsWidget],
  taskHandlers: [autoUnpinHandler],
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
          sourceUrl: {
            type: "string",
            description:
              "The page this note came from, if it was prompted by a URL the user shared — an article, a listing, a profile, anything meant to be opened and read. Renders as a link. Optional and independent of imageUrl — a note can have either, both, or neither.",
          },
          imageUrl: {
            type: "string",
            description:
              "A URL that points directly at a picture (the image bytes themselves, not a page that merely contains one), to show alongside the note. Renders as an image. Use this — not sourceUrl — whenever the URL itself is a photo or graphic, even if it has no file extension (common for CDN and Unsplash-style URLs). Optional and independent of sourceUrl.",
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
          {
            id: string;
            text: string;
            pinned: boolean;
            source_url: string | null;
            image_url: string | null;
            image_asset_id: string | null;
            created_at: Date;
          }[]
        >`
          SELECT id, text, pinned, source_url, image_url, image_asset_id, created_at FROM notes
          ORDER BY pinned DESC, created_at DESC LIMIT 20
        `;
        const notes: NoteRow[] = rows.map((row) => ({
          id: row.id,
          text: row.text,
          pinned: row.pinned,
          sourceUrl: row.source_url,
          imageUrl: row.image_url,
          imageAssetId: row.image_asset_id,
          createdAt: row.created_at,
        }));
        // The payload is the data; the view is how to draw it. A client that
        // has no renderer for this kind now falls back to a readable card
        // built from the payload rather than showing nothing.
        rt.emit("reference.note-list", { notes }, noteListView(notes));
        return notes;
      },
    },
    {
      name: "generateNoteImage",
      description:
        "Generate a feature image for an existing note, from its text. This only creates a proposal showing the image — a human must approve it before the note carries it.",
      parameters: {
        type: "object",
        properties: {
          noteId: {
            type: "string",
            description: "The id of the note to generate an image for.",
          },
        },
        required: ["noteId"],
        additionalProperties: false,
      },
      execute: async (args: unknown) => {
        const { noteId } = z.object({ noteId: z.string() }).parse(args);

        // The same read-only handle `listNotes` uses above — this tool has
        // no write of its own to make. Only `noteImageProposalKind`'s
        // `write`, run after a human approves, is allowed to touch the row.
        const [note] = await rt.db<{ text: string }[]>`
          SELECT text FROM notes WHERE id = ${noteId}
        `;
        if (!note) throw new Error(`No note with id ${noteId}`);

        // Constructed here, not at module scope: the gateway injects
        // Gemini's credentials into `process.env` per request, so a client
        // built when this file first loads would find them missing.
        const ai = new GoogleGenAI({});
        const response = await ai.models.generateContent({
          model: IMAGE_MODEL,
          contents: `Generate a simple feature image for a note that reads: ${note.text}`,
          config: { responseModalities: ["IMAGE"] },
        });

        // The SDK's own `.data` convenience getter concatenates every inline
        // part into one re-encoded base64 string and drops which part had
        // which mime type — useless here, since `rt.assets.put` needs both.
        // Walking `candidates[0].content.parts` directly is the only way to
        // get bytes and their content type from the same part.
        const imagePart = response.candidates?.[0]?.content?.parts?.find(
          (part) => part.inlineData?.data,
        );
        if (!imagePart?.inlineData?.data || !imagePart.inlineData.mimeType) {
          throw new Error("Gemini returned no image for this note");
        }

        // Stored before the human has decided anything, because the proposal
        // card below has to show the image for a human to judge it. A
        // rejected or abandoned proposal therefore leaves these bytes behind
        // with nothing pointing at them — the kit has no orphan sweep yet.
        const asset = await rt.assets.put({
          bytes: Buffer.from(imagePart.inlineData.data, "base64"),
          contentType: imagePart.inlineData.mimeType,
        });

        // The row `put` returns also carries a URL field, always null for a
        // bytes upload, and it is never read here — the id above is the
        // only handle a card is allowed to carry. There is no public path to
        // an asset's bytes by design (see `noteImageProposalView`).
        const payload: NoteImagePayload = { noteId, assetId: asset.id };
        return rt.propose(
          "reference.note.attach",
          payload,
          noteImageProposalView(payload),
        );
      },
    },
  ],
};
