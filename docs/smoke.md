# Protocol smoke, against a deploy preview

Proves the whole surface end to end against a deploy preview: the mount at `/agent/*`,
the background turn function, the SSE stream, the scheduled tick, and everything the
notes skill added — widgets, mutations, a scheduled chore, and a generated asset.

This project is verified against Netlify deploys and deploy previews, not a local dev
server, so this walk targets a preview URL, not `localhost`. That is not just a
preference: the feature-image step calls Gemini through the Netlify AI Gateway, and the
gateway only injects credentials for a deployed site. There is no local path through that
step at all.

Run every command from the repo root, in a terminal.

## Setup

Open a PR from this branch. Netlify builds a deploy preview and posts its URL as a check
on the PR — that becomes your base:

```sh
BASE=https://deploy-preview-4--<your-site>.netlify.app/agent
```

Get the bearer. Open the preview site itself (not `$BASE`, the root) in a browser, unlock
the admin form with the site's `AGENT_ADMIN_KEY`, and copy the connection token it reveals
— see the README's "Connecting a client":

```sh
K="Authorization: Bearer <connection token from the admin page>"
```

No migration step here. `netlify.toml`'s top comment and the README both say it:
`@netlify/database` applies everything in `netlify/database/migrations/` automatically
before a preview publishes. If a migration were broken, the preview build would fail
before you had a URL to test against.

## The sequence

```sh
# 1. Auth gate + protocol version
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/summary"   # 401
curl -s -H "$K" "$BASE/summary"
```

```json
{"agentId":"...","displayName":"...","protocolVersion":"0.3","kitVersion":"0.8.0",
  "transports":["http"],
  "capabilities":["message","events","events.stream","threads","decision","models",
  "visibility","admin","assets","widgets","mutations","scheduler"]}
```

The notes skill declares widgets, mutations, and a task handler, so `capabilities` must
carry all four of `widgets`, `mutations`, `scheduler`, and `assets` (the last is
kit-provided, unconditional). Assert it instead of eyeballing the array:

```sh
curl -s -H "$K" "$BASE/summary" \
  | jq -e '["widgets","mutations","scheduler","assets"] - .capabilities == []'
```

`true` — an empty set difference means every required capability is present.

```sh
# 2. A thread. Body may be {} or {"title":"..."}; the response carries the id.
curl -s -X POST -H "$K" -H "content-type: application/json" \
  -d '{"title":"smoke"}' "$BASE/threads"
T=<id from above>
```

```sh
# 3. A message. The model calls `createNote`, which only proposes — nothing is
#    saved yet. The message names both a source page (sourceUrl, renders as a
#    link) and a direct picture URL (imageUrl, renders as an image) — see
#    step 9. The image URL deliberately carries no file extension (a resize
#    query param instead, like a real Unsplash/CDN URL) to prove the fields
#    are told apart by the model, not guessed from the URL's shape.
curl -s -X POST -H "$K" -H "content-type: application/json" \
  -d "{\"threadId\":\"$T\",\"text\":\"Please add a note that says 'Remember to read this later.' It is from https://example.com/cats-article, and here is a picture to go with it: https://images.unsplash.com/photo-1667599611951-7e27a50f690e?w=400.\"}" \
  "$BASE/message"
```

`{"turnId":"..."}` comes back fast. `agent-turn.ts` is declared `background: true`, so
Netlify answers its internal dispatch with a 202 immediately and runs the turn off to the
side — unlike the old local emulator, which ran it synchronously and made the whole
request wait out the model call.

```sh
# 4. The log. Poll a few times over ~20s until turn.finished shows up.
curl -s -H "$K" "$BASE/events?since=0"
```

On a deploy this actually completes — the gateway has real credentials here, so expect
`thread.created`, `turn.started`, `chat.appended` (the user message), `proposal.created`
(kind `reference.note`, payload carrying both your `sourceUrl` and `imageUrl`),
`chat.appended` (the assistant's reply), then `turn.finished` with `status: "done"`. Grab
the proposal id:

```sh
P=<id from proposal.created above>
```

```sh
# 5. Decide it — the "pin" outcome, not a plain approve. `pin` is the one outcome
#    that also queues notes.autoUnpin seven days out, in the same transaction as
#    the insert (skills/notes.ts). Approving would save the note but skip that.
curl -s -X POST -H "$K" -H "content-type: application/json" \
  -d '{"action":"outcome","outcome":"pin"}' \
  "$BASE/proposals/$P/decision"
```

`GET $BASE/proposals` (defaults to pending) should now come back empty — the only
pending proposal just resolved.

```sh
# 6. Confirm the scheduled task actually landed. Requires the site linked
#    (`netlify link`, once) and you logged in.
DB=$(netlify database status --branch <preview-git-branch> --show-credentials --json \
  | jq -r '.database.connectionString')
psql "$DB" -c "SELECT kind, run_at, status FROM selfctl_scheduled_tasks \
  WHERE kind = 'notes.autoUnpin' ORDER BY created_at DESC LIMIT 1;"
```

One row, `run_at` about a week out, `status = 'pending'`.

```sh
# 7. The stream: frames now, a ": ping" every 15s idle, "event: end" at 50s.
curl -sN --max-time 8  -H "$K" "$BASE/events/stream?since=0"
curl -sN --max-time 60 -H "$K" "$BASE/events/stream?since=0"
```

```sh
# 8. The dashboard widget. notes-stats runs one aggregate query and renders it
#    as a keyValue node; it returns null (and this list is empty) on a fork
#    with zero notes.
curl -s -H "$K" "$BASE/summary/widgets"
```

```json
[{"id":"notes-stats","title":"Notes","component":{"kind":"reference.notes-stats",
  "payload":{"total":1,"pinned":1,"withImage":0},
  "view":{"type":"keyValue","items":[{"label":"Total","value":"1"},
  {"label":"Pinned","value":"1"},{"label":"With image","value":"0"}]}}}]
```

(Counts reflect whatever else already exists in this preview's database — don't expect
exactly this.)

```sh
# 9. Ask the agent to list its notes. This is what emits the reference.note-list
#    view built in noteListView — `link` and `image` are independent nodes now,
#    not a guess branching on one field's shape, so a note with both fields
#    should render both. It's also how you find the note's id.
curl -s -X POST -H "$K" -H "content-type: application/json" \
  -d "{\"threadId\":\"$T\",\"text\":\"Please list my notes.\"}" \
  "$BASE/message"
sleep 3
curl -s -H "$K" "$BASE/threads/$T/messages"
```

Find the assistant message with `components: [{"kind":"reference.note-list",...}]`. Its
view's `stack` for your note should carry a `badge` ("pinned"), a `link` node for
`sourceUrl` (`{"type":"link","href":"https://example.com/cats-article","label":"Source"}`),
and an `image` node for `imageUrl`
(`{"type":"image","src":"https://images.unsplash.com/photo-1667599611951-7e27a50f690e?w=400",...}`)
— both present at once, which is the structural proof the two fields render
independently now rather than one being derived from the other. The payload alongside it
carries the note's id:

```sh
N=<note id from the reference.note-list payload>
```

```sh
# 10. A mutation call. No proposal, no approval — the button is only reachable
#     from a view this agent already rendered for you, so the id is trusted.
curl -s -X POST -H "$K" -H "content-type: application/json" \
  -d "{\"kind\":\"notes.unpin\",\"payload\":{\"id\":\"$N\"}}" \
  "$BASE/mutations"
```

`{"ok":true}`, and the event log gains a `mutation.applied` entry (`{"kind":"notes.unpin"}`).
The scheduled task from step 6 is untouched — `autoUnpinHandler` only cares whether the
note is still pinned when its own week is up, and it's fine if this makes that a no-op.

```sh
# 11. A generated feature image. Runs in the background turn function, not the
#     60s-capped request path, so a slow generation is expected. Poll like step 4.
curl -s -X POST -H "$K" -H "content-type: application/json" \
  -d "{\"threadId\":\"$T\",\"text\":\"Please generate a feature image for note $N.\"}" \
  "$BASE/message"
curl -s -H "$K" "$BASE/events?since=<cursor from step 9>"
```

Look for `proposal.created` with kind `reference.note.attach`, payload `{"noteId":"...","assetId":"..."}`.
Grab both, then approve (a plain approve — this kind has no named outcomes):

```sh
P2=<id from proposal.created above>
A=<assetId from the same payload>
curl -s -X POST -H "$K" -H "content-type: application/json" \
  -d '{"action":"approve"}' \
  "$BASE/proposals/$P2/decision"
```

```sh
# 12. Fetch the asset back — the whole point of `asset` over `image`: no public
#     URL exists, only a bearer-gated id.
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/assets/$A"        # 401, no bearer
curl -s -D - -o feature.png -H "$K" "$BASE/assets/$A" | head -5   # 200, image bytes
```

Headers should show `content-type: image/...` (whatever Gemini returned) and
`cache-control: private, max-age=31536000, immutable` — private because it's bearer-gated,
immutable because an asset id never changes underneath itself.

## The scheduled tick, on a deploy preview

`agent-tick.ts` declares `schedule: "* * * * *"` and nothing else — a scheduled function
has no path, no bearer check, and nothing to curl.

Netlify only *runs* a scheduled function automatically on a published production deploy —
not on a deploy preview or branch deploy. On this preview, `agent-tick` will not fire on
its own no matter how long you wait, so drain it by hand instead of watching for it.

First queue a task with a past `run_at`, using the connection string from step 6:

```sh
psql "$DB" -c "INSERT INTO selfctl_scheduled_tasks (id, kind, payload) VALUES \
  ('smoke-task-1', 'selfctl.turn', '{\"threadId\":\"$T\",\"text\":\"Scheduled smoke ping\"}'::jsonb);"
```

Then trigger the function yourself: in the Netlify UI, open this deploy → Functions →
`agent-tick`, and use its **Run now** control. Poll the event log afterward — a
`turn.started` / `chat.appended` / `turn.finished` trio for the scheduled turn, followed by
`task.finished {"kind":"selfctl.turn","status":"done","taskId":"smoke-task-1",...}`, shows
the tick picked the task up and drained it.

(If you also want to see the automatic once-a-minute cadence — invocations rolling in on
their own, each logging its claimed/done report — that only shows up on production, once
this work has merged and deployed there.)

## What only a client can show you

Everything above proves the wiring with raw JSON. How it actually *looks* — whether
`link`, `image`, `asset`, and the mutation buttons render the way a person would expect —
you have to judge by eye, in a protocol client (the desktop app) pointed at `$BASE` with
the same connection token. Look for:

- The note from step 3 shows both a tappable "Source" link and its cover picture inline,
  at once — `sourceUrl` and `imageUrl` rendering independently, not one guessed from the
  other's shape. Add a second note by hand with only a `sourceUrl` (no picture URL) and
  confirm that one renders as a link with no image — the two fields are optional and
  independent, not a package deal.
- After approving the feature image in step 12, the same note grows a second picture —
  the generated `asset` — distinct from the first: one is a URL the client fetched
  directly, the other only resolved because the client presented its bearer.
- Each note's card offers "Unpin" (only while pinned, no confirmation) and "Delete". Delete
  should take two presses — the first arms it, showing the confirm text from
  `skills/notes.ts`; the second actually removes the note.
