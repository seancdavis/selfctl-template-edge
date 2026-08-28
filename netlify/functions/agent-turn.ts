import { createTurnHandler } from "@selfctl/agent-kit";
import { agent } from "../../selfctl.config";

// Where a turn actually runs. It must be a **background** function: Netlify
// answers 202 immediately and then gives it fifteen minutes, instead of the
// sixty seconds a request gets. `/_selfctl/turn` sits outside the protocol's
// base path on purpose — it is this app's raw background function, and the kit
// only supplies its handler.
export default createTurnHandler(agent);

export const config = { path: "/_selfctl/turn", background: true };
