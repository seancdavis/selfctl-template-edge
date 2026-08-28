import { createAgentHandler } from "@selfctl/agent-kit";
import { createFileRoute } from "@tanstack/react-router";
import { agent } from "../../selfctl.config";

// The protocol mount. Every method under `/agent/*` goes to the same handler —
// the kit owns the routing table, this app owns nothing but the mount point.
const handle = createAgentHandler(agent);
const h = ({ request }: { request: Request }) => handle(request);

export const Route = createFileRoute("/agent/$")({
  server: {
    handlers: {
      GET: h,
      POST: h,
      PUT: h,
      PATCH: h,
      DELETE: h,
      OPTIONS: h,
      HEAD: h,
    },
  },
});
