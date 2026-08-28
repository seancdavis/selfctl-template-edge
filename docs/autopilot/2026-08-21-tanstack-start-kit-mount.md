# 2026-08-21 — Rebuild the template as a TanStack Start app with the kit mounted at /agent/*

Source plan: `.docs/mvp-plan-a-d.md` §B2/B4 in the selfctl monorepo
(`~/workspace/seancdavis/selfctl`); stance in `.docs/agent-framework-handoff.md` there. This
run consumes `@selfctl/agent-kit` 0.4.0 and `@selfctl/protocol` 0.2.0 from **packed tarballs**
on the monorepo branch `21-mvp-kit-protocol-surface` (selfctl#21), not from npm.

## Intent

After this runs, a fork of this repo is an app: TanStack Start pages and typed server functions
over the fork's own database, with the whole agent protocol served by the kit under `/agent/*`
from one server route, a background turn function, and a scheduled tick. The template carries
no protocol code of its own — `selfctl.config.ts`, `db/schema.ts`, `skills/`, a handful of
routes, two two-line Netlify functions. The reference deploy's old tables are replaced by the
kit's `selfctl_*` tables plus `notes`.

## Scope

**In:** this repo entirely. **Out:** publishing the packages (Sean); deploying; the lockfile
regeneration against published versions (Sean, see External dependencies); kit-shipped React
components; any change to the kit (if the kit is wrong, stop and report — don't patch around it
here); rich admin UI beyond claim flow + model picker; auth beyond `AGENT_ADMIN_KEY`.

**Deletion sweep:** before deleting `netlify/functions/*`, `netlify/functions/_shared/*`, and the
old tables, run `rg --hidden -n "<name>"` over the repo for each removed module and table name
(`events`, `pending_proposals`, `chat_threads`, `chat_messages`, `config` as table names;
`_shared/agent`, `_shared/deps`, `_shared/events`, `redact`, `curated-models`) and disposition
every hit. `README.md` and `docs/autopilot/*-report.md` references to old routes: README is fix
in scope; reports are historical-leave.

## Plan

1. **Scaffold TanStack Start on Netlify.** Versions via `npm view` (today: `@tanstack/react-start`
   1.168.x, `@netlify/vite-plugin-tanstack-start` 1.3.x, `vite` 8.x). Files: `vite.config.ts`
   (`tanstackStart()`, `netlify()`, `viteReact()`), `src/router.tsx`, `src/routes/__root.tsx`,
   `src/routes/index.tsx` (placeholder), `tsconfig.json` updated for JSX + `src`. `netlify.toml`:
   `[build] command = "vite build"`, `publish = "dist/client"`; keep `[db]`/edge-function
   config. Scripts: `dev` = `vite dev`, `build` = `vite build`, keep `typecheck`, `db:generate`.
   Delete `public/index.html` and `public/main` (the old admin page) — `public/` keeps a
   `.gitkeep`.
   - Check: `npm run build` succeeds; `npm run typecheck` clean; `curl -s http://localhost:<port>/`
     from `npm run dev` returns HTML containing the placeholder text.

2. **Install the kit + protocol from tarballs; mount the kit.** `npm i <monorepo>/packages/agent-kit/selfctl-agent-kit-0.4.0.tgz <monorepo>/packages/protocol/selfctl-protocol-0.2.0.tgz`
   (run `pnpm --filter @selfctl/agent-kit pack` / protocol pack in the monorepo first if the
   tarballs are missing). `selfctl.config.ts`: `export const agent = defineAgent({ id, displayName, systemPrompt, skills: [notesSkill], models: { default: "claude-haiku-4-5", shortlist } })`
   — port the system prompt and the curated model shortlist from `_shared/system.ts` and
   `_shared/curated-models.ts`. `skills/notes.ts` ported from `_shared/skills/notes.ts`
   unchanged in behavior. `src/routes/agent.$.ts`:
   ```ts
   import { createFileRoute } from "@tanstack/react-router";
   import { createAgentHandler } from "@selfctl/agent-kit";
   import { agent } from "../../selfctl.config";
   const handle = createAgentHandler(agent);
   const h = ({ request }: { request: Request }) => handle(request);
   export const Route = createFileRoute("/agent/$")({ server: { handlers: { GET: h, POST: h, PUT: h, PATCH: h, DELETE: h, OPTIONS: h } } });
   ```
   (verify the server-route API against the installed `@tanstack/react-start` types; this is
   the documented shape as of 1.168). `netlify/functions/agent-turn.ts`
   (`createTurnHandler(agent)`, `config = { path: "/_selfctl/turn", background: true }`) and
   `netlify/functions/agent-tick.ts` (`createTickHandler(agent)`, `config = { schedule: "* * * * *" }`).
   `netlify/edge-functions/cors.ts` path → `/agent/*`. Delete the 12 functions and `_shared/`.
   - Check: `npm run typecheck`; `npm run build`; `ls netlify/functions` shows exactly
     `agent-turn.ts agent-tick.ts`; the deletion sweep returns nothing outside README/reports.

3. **Database: kit tables + notes; regenerate migrations.** `db/schema.ts` =
   `export * from "@selfctl/agent-kit/db";` + the existing `notes` table. `db/index.ts` keeps
   the drizzle client for pages (`getConnectionString()`). Run `npm run db:generate`; the new
   migration must drop `events`, `pending_proposals`, `chat_threads`, `chat_messages`, `config`
   and create every `selfctl_*` table; append to the same migration
   `INSERT INTO selfctl_event_cursor (id, seq) VALUES (1, 0); INSERT INTO selfctl_config (id) VALUES (1);`
   (singleton seeds). Data loss on the reference deploy is accepted (Sean, 2026-08-21).
   - Check: `npm run db:generate` again is a no-op ("No schema changes"); the migration SQL
     contains `DROP TABLE` for the five old tables and `CREATE TABLE "selfctl_events"`; under
     `npm run dev`, `netlify database migrations apply` (or the plugin's auto-apply) succeeds
     and `psql $NETLIFY_DB_URL -c '\dt'` lists `notes` + the `selfctl_*` tables only.

4. **Admin page as a template-owned route.** `src/routes/index.tsx`: unlock with
   `AGENT_ADMIN_KEY` → shows the connection token (`GET /agent/config/token`) and the model
   picker (`GET|POST /agent/config/settings`), calling the kit's routes with the admin key as
   bearer. Plain React, no UI library. Keep it under ~150 lines.
   - Check: `npm run build`; `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/`
     → 200; `curl -H "Authorization: Bearer $AGENT_ADMIN_KEY" http://localhost:<port>/agent/config/token`
     → JSON with a token. `human-verify:` the unlock + picker flow in a browser.

5. **Protocol smoke under the dev server.** With `AGENT_ADMIN_KEY=test npm run dev` (or
   `netlify dev` if the plugin doesn't run the two raw functions — record which worked):
   `GET /agent/summary` 401 then 200 with `protocolVersion: "0.2"`; `POST /agent/threads`;
   `POST /agent/message` returns `{turnId}` in <1s; `GET /agent/events?since=0` shows
   `turn.started … turn.finished` (the turn may finish with `status:"error"` if AI Gateway
   isn't reachable locally — that is still a pass for the plumbing; say so in the report);
   `curl -N /agent/events/stream?since=0` streams frames and ends with `event: end`;
   `netlify functions:invoke agent-tick` (or the plugin equivalent) returns without error.
   Write the exact command sequence to `docs/smoke.md` so it's repeatable.
   - Check: the sequence above, run end to end, with the outputs pasted into the report.

6. **README + package versions.** README rewritten for the new shape: what a fork is (an
   app), the file map, the `/agent` base URL for clients, the DB rule (fork owns the database;
   upgrade = `npm i @selfctl/agent-kit@latest` → `npm run db:generate` → commit), the frontend
   rule (read anything directly; write only through `/agent/*`), env vars, Deploy-to-Netlify
   button unchanged. Set `package.json` deps to `"@selfctl/agent-kit": "^0.4.0"`,
   `"@selfctl/protocol": "^0.2.0"` **without** running `npm install` (the packages aren't
   published; the lockfile stays pointing at the tarballs until Sean regenerates it — see
   External dependencies). Leave a top-of-PR note saying exactly that.
   - Check: `rg -n "0.4.0|0.2.0" package.json` shows both; `rg -n "/summary\b" README.md`
     shows only `/agent/summary`-prefixed examples.

## Program design

```
selfctl.config.ts          defineAgent({...})                  ← the only place the agent is described
db/schema.ts               export * from "@selfctl/agent-kit/db"; export const notes = pgTable(...)
db/index.ts                drizzle client for pages (read-only use by convention)
skills/notes.ts            the one skill
src/router.tsx, src/routes/__root.tsx
src/routes/index.tsx       admin page
src/routes/agent.$.ts      protocol mount (all methods → createAgentHandler)
netlify/functions/agent-turn.ts   background turn (path /_selfctl/turn)
netlify/functions/agent-tick.ts   scheduled tick
netlify/edge-functions/cors.ts    CORS for /agent/*
netlify/database/migrations/      fork-owned; one new migration this run
vite.config.ts, netlify.toml, docs/smoke.md
```

No server function in this template writes domain data; the admin page only calls the kit's
admin routes. A later book-tracker fork adds `books`/`reading_history` tables and a report
route — that is the pattern this layout must make obvious.

## Exemplars

- Netlify's TanStack Start reference: https://tanstack.com/start/latest/docs/framework/react/guide/server-routes
  and `@netlify/vite-plugin-tanstack-start` README (installed in `node_modules`).
- `netlify/functions/_shared/skills/notes.ts` (before deletion) — the skill to port verbatim.

## Done-signal

1. `npm run typecheck`, `npm run build` exit 0.
2. `ls netlify/functions` = `agent-tick.ts agent-turn.ts`; `test ! -d netlify/functions/_shared`;
   `test ! -f public/index.html`.
3. `rg -n 'from "@selfctl/agent-kit/db"' db/schema.ts` hits; `npm run db:generate` reports no
   changes; the newest migration's SQL contains `CREATE TABLE "selfctl_events"` and the five
   `DROP TABLE`s.
4. `rg -n 'createFileRoute\("/agent/\$"\)' src/routes/agent.\$.ts` hits; `rg -n '"/_selfctl/turn"' netlify/functions/agent-turn.ts` hits; `rg -n 'schedule:' netlify/functions/agent-tick.ts` hits.
5. The slice-5 smoke sequence passes end to end under the dev server and is written to `docs/smoke.md`.
6. `package.json` pins `^0.4.0` / `^0.2.0`; the README has no un-prefixed protocol routes.
7. `human-verify:` Deploy-to-Netlify preview builds after Sean publishes + regenerates the
   lockfile; a real turn answers through AI Gateway; SSE streams through the CDN; the cron
   fires on the published deploy; the admin unlock + model picker in a browser; the desktop
   app connects with base URL `https://<site>/agent`.

## Audit lenses

- **simplicity** — the template holds intent only; any protocol logic that crept in goes back
  to the kit (report it, don't fork it); no unused TanStack scaffolding.
- **security** — `AGENT_ADMIN_KEY` never reaches the client bundle (server-only reads); the
  admin page sends the key only as a bearer to `/agent/config/*`; CORS scoped to `/agent/*`;
  the connection token is never logged.

## Issue

#13 — https://github.com/seancdavis/selfctl-template/issues/13

## Branch

`13-tanstack-start-kit-mount` (off `main`)

## Guardrails

- Loop bound: 3 audit/fix rounds.
- End by opening a PR to `main` (closes #13) — **draft** regardless (the lockfile step is
  Sean's), with the verify note listing the publish → `npm install` → commit step first.
  Never merge, never publish, never deploy.

## External dependencies

- Tarballs from the monorepo branch `21-mvp-kit-protocol-surface` (`pnpm --filter @selfctl/agent-kit pack`,
  `pnpm --filter @selfctl/protocol pack`).
- After the run, Sean: publish `@selfctl/protocol@0.2.0` and `@selfctl/agent-kit@0.4.0`, then in
  this repo `npm install` to regenerate `package-lock.json` against the published versions and
  commit — otherwise every Deploy-to-Netlify build fails (lesson from the July runs).
- Local AI Gateway access is not assumed; the smoke treats a `status:"error"` turn as a
  plumbing pass.
