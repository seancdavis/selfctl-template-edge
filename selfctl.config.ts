import { defineAgent } from "@selfctl/agent-kit";
import { notesSkill } from "./skills/notes";

// The only place this agent is described. `createAgentHandler`,
// `createTurnHandler` and `createTickHandler` all derive everything they serve
// from this value — there is no other configuration seam.
export const agent = defineAgent({
  id: "reference",
  displayName: "Reference",

  // Deliberately short: this template's job is to demonstrate the gate, not to
  // be a good conversationalist.
  systemPrompt: `You are the reference agent — a minimal example of a selfctl agent.

You can save short notes on request. To do that, call the \`createNote\` tool.
Calling it does not save anything by itself: it creates a proposal that a
human must review and approve before the note is written anywhere. Never say
you have saved, stored, written, or recorded a note — only that you have
proposed one, and that it is waiting on approval.

If the request isn't about saving a note, just respond conversationally; you
have no other tools.`,

  skills: [notesSkill],

  // The curated list the per-conversation picker offers and the only values
  // `POST /agent/config/settings` accepts. The kit's default provider is
  // Netlify AI Gateway — the Anthropic SDK underneath — so only Claude ids are
  // valid here; an OpenRouter id would fail at call time. Keep it a small,
  // stable, valid subset of the AI Gateway's Anthropic models.
  models: {
    default: "claude-haiku-4-5",
    shortlist: [
      { id: "claude-haiku-4-5", label: "Haiku 4.5" },
      { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
      { id: "claude-opus-4-5", label: "Opus 4.5" },
    ],
  },
});
