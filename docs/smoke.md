# Protocol smoke, locally

Proves the whole surface end to end against `vite dev`: the mount at `/agent/*`, the
background turn function, the SSE stream, and the scheduled tick. `vite dev` alone is
enough — `netlify dev` is **not** needed, the Netlify Vite plugin runs the raw
`netlify/functions/*.ts` files too.

Run every command from the repo root, in a second terminal, with the dev server up.

## Setup

```sh
lsof -ti :5173 | xargs kill                       # clear a leftover dev server
AGENT_ADMIN_KEY=test-admin-key npm run dev        # port 5173
```

No `DEPLOY_PRIME_URL` override needed: under `CONTEXT=dev` the kit self-invokes the dev
server automatically instead of addressing the synthesized (and wrong) deploy origin.

Then, in the second terminal:

```sh
K="Authorization: Bearer test-admin-key"
npx netlify database migrations apply             # "No pending migrations to apply."
```

## The sequence

```sh
# 1. Auth gate + protocol version
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/agent/summary   # 401
curl -s -H "$K" http://localhost:5173/agent/summary                            # 200, protocolVersion "0.2"

# 2. A thread. Body may be {} or {"title":"..."}; the response carries the id.
curl -s -X POST -H "$K" -H "content-type: application/json" \
  -d '{"title":"smoke"}' http://localhost:5173/agent/threads
T=<id from above>

# 3. A message. Returns {turnId} and hands the turn to the background function.
curl -s -w "\ntime_total=%{time_total}\n" -X POST -H "$K" \
  -H "content-type: application/json" \
  -d "{\"threadId\":\"$T\",\"text\":\"Please add a note that says hello\"}" \
  http://localhost:5173/agent/message

# 4. The log. Poll a few times over ~20s.
curl -s -H "$K" "http://localhost:5173/agent/events?since=0"

# 5. The stream: frames now, a ": ping" every 15s idle, "event: end" at 50s.
curl -sN --max-time 8  -H "$K" "http://localhost:5173/agent/events/stream?since=0"
curl -sN --max-time 60 -H "$K" "http://localhost:5173/agent/events/stream?since=0"

# 6. The scheduled tick. Netlify won't fire it on a schedule locally; the plugin
#    exposes it at the emulated function path instead. (On a real deploy a scheduled
#    function has no URL — this path is local-emulation only.)
curl -s -X POST http://localhost:5173/.netlify/functions/agent-tick

#    To watch it actually drain something, queue a due task first:
DB=$(node -p "require('./.netlify/state.json').dbConnectionString")
psql "$DB" -c "INSERT INTO selfctl_scheduled_tasks (id, kind, payload) VALUES \
  ('smoke-task-1', 'selfctl.turn', '{\"threadId\":\"$T\",\"text\":\"Scheduled smoke ping\"}'::jsonb);"
curl -s -X POST http://localhost:5173/.netlify/functions/agent-tick   # claimed 1, done 1
curl -s -X POST http://localhost:5173/.netlify/functions/agent-tick   # claimed 0

# 7. Stop
lsof -ti :5173 | xargs kill
```

## What a healthy run looks like

`GET /agent/summary` — 401 bare, then:

```json
{"agentId":"reference","displayName":"Reference","protocolVersion":"0.2","kitVersion":"0.4.0",
 "transports":["http"],"capabilities":["message","events","events.stream","threads","decision","models","visibility","admin"]}
```

`POST /agent/message` → `{"turnId":"5444546a-…"}`. Locally this takes ~1.8s, not the
sub-second a deploy answers in: the emulator runs the "background" function
**synchronously**, so the POST waits out the whole turn. On Netlify the same call gets a
202 back immediately and returns in well under a second.

`GET /agent/events?since=0` — the turn's four events, in order:

```
1 thread.created
2 turn.started    {"threadId":"c2b873d2-…","retryAttempt":0,"parentProposalId":null}
3 chat.appended   {"message":{"role":"user","text":"Please add a note that says hello"},…}
4 turn.finished   {"status":"error","error":"Could not resolve authentication method. Expected one of
                   apiKey, authToken, credentials, config, or profile to be set…"}
```

**That error is a pass.** Every step of the plumbing ran — the message became a durable
turn, the self-call reached `/_selfctl/turn`, the background function loaded the agent and
started thinking — and then the Anthropic SDK found no credentials, because AI Gateway
injects them only for a project linked to a Netlify site. `dispatch failed: …` in that
slot is a *failure* (the self-call didn't reach `/_selfctl/turn` at all); a provider-auth
error is not.

`GET /agent/events/stream?since=0` — one `id:`/`event:`/`data:` frame per event, then a
`: ping` every 15 seconds of silence, then at 50s:

```
: ping
event: end
data: {"cursor":11}
```

The tick returns 200 and its report:

```json
{"claimed":1,"done":1,"retrying":0,"failed":0,"batches":1,"budgetExhausted":false,"sweptTurns":0}
{"claimed":0,"done":0,"retrying":0,"failed":0,"batches":0,"budgetExhausted":false,"sweptTurns":0}
```

and the log gains the scheduled turn plus its `task.finished`:

```
12 turn.started    13 chat.appended {"text":"Scheduled smoke ping"}   14 turn.finished
15 task.finished   {"kind":"selfctl.turn","status":"done","taskId":"smoke-task-1","turnId":"b0b05c51-…","attempts":0}
```

A `selfctl.turn` task reports `done` even though the turn it started errored — the task's
job was to start the turn, and it did.
