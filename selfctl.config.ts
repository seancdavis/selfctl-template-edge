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

You can also generate a feature image for a note you already know the id of
(use \`listNotes\` first if you need it). To do that, call the
\`generateNoteImage\` tool with that note's id. Calling it does not attach
anything by itself either: it creates a proposal showing the generated image
that a human must review and approve before the note carries it. Never say
you have attached, added, or set an image — only that you have generated one
for review.

If the request isn't about notes, just respond conversationally.`,

  skills: [notesSkill],

  // The curated list the per-conversation picker offers and the only values
  // `POST /agent/config/settings` accepts. Both providers go through Netlify
  // AI Gateway, so no keys are needed. An entry naming `provider: "openrouter"`
  // takes an OpenRouter slug. An entry with none uses the agent's provider
  // (`netlify-aig`, the Anthropic SDK underneath) and takes a bare Claude id.
  // Keep every id one the gateway actually serves.
  models: {
    default: "z-ai/glm-5.3",
    shortlist: [
      { id: "z-ai/glm-5.3", label: "GLM 5.3", provider: "openrouter" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5" },
      { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
      { id: "claude-opus-4-5", label: "Opus 4.5" },
    ],
  },
});
