import type { Config } from "@netlify/edge-functions";
import corsEdge from "@selfctl/agent-kit/edge-cors";

// Thin wiring stub: Netlify must find a file in `netlify/edge-functions/` to
// register an edge function, but all the behavior lives in the kit so a
// `@selfctl/agent-kit` bump propagates any CORS fix without touching this
// template. Only the route pattern (stable) is declared here.
export default corsEdge;

export const config: Config = {
  path: "/*",
};
