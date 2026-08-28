import { createTickHandler } from "@selfctl/agent-kit";
import { agent } from "../../selfctl.config";

// The once-a-minute scheduler. Its config declares only a schedule: a
// scheduled function is not routable, has no public URL, and that is exactly
// why it needs no bearer check. Its own file because `background` is
// per-function and a fire-and-forget tick has no visible failure.
export default createTickHandler(agent);

export const config = { schedule: "* * * * *" };
