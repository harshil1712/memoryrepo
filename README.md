# markdown memory

> **Fork note:** this variant runs all models on **Workers AI** via the `env.AI` binding — no
> OpenRouter key, no third-party API — so the entire deployment stays inside your Cloudflare
> account. Everything else matches upstream.

An AI agent whose long-term memory is **a git repo of markdown**: an LLM wiki it reads, writes, and tidies up itself.

- **`MEMORY.md`** is the entry point. It's loaded into every conversation, kept short, and links out to topic files (`people/priya.md`, `projects/…`, `preferences/…`).
- **One fact per line, with provenance:** `- Priya moved to Pune [source: thread/ab12cd34#m9; added: 2026-10-05]`. Files link to each other with `[[people/priya]]`.
- **The agent remembers as it goes.** It greps the repo and follows links to recall, and every memory write is a commit, pushed immediately.
- **Notes, too.** Besides chatting, you can write notes in a block editor (`/` commands, task lists, drag handle; the editor experience follows [notty](https://github.com/Dhravya/notty)). Notes are stored as markdown. The next dream reads new or edited notes and folds what's durable into memory, citing `note/<id>`.
- **Dreaming** is a periodic background agent. It adds patterns across conversations, merges duplicates, removes outdated entries, and opens the cited conversation to resolve contradictions.
- **Everything is inspectable:** a file tree, rendered notes with backlinks, an Obsidian-style graph, full commit history with diffs, a live dream log, and the cost of every turn and dream.

The technique follows Cognition's [agent memory repo](https://cognition.com/agent-memory-repo), applied to personal memory.

## How it works

```
Browser (React)
  ├── ws → ChatAgent  "<user>.<thread>"   one Durable Object per conversation
  └── ws → MemoryAgent "<user>"           one Durable Object per user

ChatAgent ── chatContext() ─────────► MemoryAgent        MEMORY.md + files at HEAD
ChatAgent ── applyEdits(head, …) ───► MemoryAgent ──git──► Artifacts repo   (a commit per memory write)
MemoryAgent ── alarm every 4h / "Dream now" ──► dream() ──git──► Artifacts repo (one commit per dream)
```

**Chat turn** (`src/server/chat-agent.ts`, `src/server/memory.ts`)
- The model sees `MEMORY.md` in its system prompt and has four tools:
  - `bash`: a sandboxed, read-only shell over the repo ([just-bash](https://github.com/vercel-labs/just-bash), so `rg`, `grep`, `find` and `cat` all work)
  - `memory_write`, `memory_edit`, `memory_delete`: each one is a git commit, pushed immediately
- Writes are optimistic, like `git push`. If a file the agent is changing was modified since it read it (by another conversation, or by a dream), the write is rejected and the current version comes back so the agent can merge. Writes to *different* files rebase cleanly.

**Dreaming** (`dream()` in `src/server/memory.ts`)
- A coding-agent loop over a writable copy of the repo, plus an `/inbox` of new chat messages and new or edited notes since the last dream.
- Tools: `bash`, `write_file`, `read_source` (opens the conversation or note behind a `[source: …]`) and `commit`.
- The result is pushed as one commit. If chat wrote while the dream ran, the dream's edits are rebased on top. A same-file conflict drops the dream and the next run retries.
- Runs on a Durable Object alarm every 4 hours, but only if there are new messages. The UI also has a **Dream now** button.

**Storage**
- Each user's memory is a [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) git repo, which you can clone with plain `git`.
- Reads go through the Artifacts Worker binding; writes use [isomorphic-git](https://isomorphic-git.org/) inside the Durable Object.
- Chat history, the thread list, the cost ledger and a full-text index (SQLite FTS5) live in the Durable Objects' SQLite.

## Models

Open-weight models only, through [Workers AI](https://developers.cloudflare.com/workers-ai/) (the `env.AI` binding — no API key). Pick the chat model and the dreaming model separately in the ⚙ menu:
- GLM 5.3 / 5.3 Flash
- DeepSeek V4 Pro / V4 Flash
- Kimi K2.6
- Qwen3.8 27B
- gpt-oss-120b
- Nemotron 3 120B

The list lives in `src/server/models.ts`. The defaults are GLM 5.3 for chat and DeepSeek V4 Pro for dreaming. The binding reports no per-call cost, so costs shown in the UI are metered at Cloudflare's list prices.

## Run it

You need [Bun](https://bun.sh), Node 22+, and a Cloudflare account with Artifacts enabled. Models run on Workers AI through the `env.AI` binding — no API key needed.

```sh
bun install
cp .env.example .env      # add AUTH_SECRET (openssl rand -hex 32); optionally MEMORY_API_KEY for the admin API
bun run dev               # http://localhost:1337 (first run asks you to log in to Cloudflare)
```

Deploy with `bun run deploy`. Infrastructure is defined in `alchemy.run.ts` with [Alchemy](https://alchemy.run).

> `bun run dev` goes through `scripts/alchemy.mjs`, which starts Alchemy under real Node with Bun's package-manager env vars stripped: under Bun (or with them set), the dev proxy currently drops WebSocket upgrades, which the agents need.

## HTTP API

The same agents are available over HTTP under `/api`, scoped per user id. `GET /api` lists the routes. Machine agents authenticate with the admin key (`MEMORY_API_KEY`, set in `.env`, reaches every user); humans copy their session token from the UI's API card.

```sh
alias curl='curl -H "authorization: Bearer $MEMORY_API_KEY"'
# add ?bank=<name> to any route to use another memory bank (default: main)
# user ids look like ada-3f2a1c9b0e7d (the email's local part + a hash); the UI's account menu shows yours

# chat: runs a full turn (recall + memory writes) and returns the reply and what it remembered
curl -X POST localhost:1337/api/users/ada/chat -H 'content-type: application/json' \
  -d '{"message": "my sister priya just moved to pune", "tz": "Asia/Kolkata"}'
# → {"thread": "…", "reply": "…", "memoryWrites": [{"tool": "memory_edit", "output": "committed 3f2a1c9 · people/priya.md"}], "cost": {…}, "stats": {…}}

curl localhost:1337/api/users/ada/memory                 # {head, paths}
curl localhost:1337/api/users/ada/memory/MEMORY.md       # the file, as markdown (?ref=<commit> for history)
curl 'localhost:1337/api/users/ada/search?q=pune'        # full-text hits in memory and conversations
curl localhost:1337/api/users/ada/history                # commits: chat(<thread>): … and dream: …
curl -X POST localhost:1337/api/users/ada/dream          # dream now; GET the same path for status + log
curl localhost:1337/api/users/ada/costs                  # spend so far
```

| route | |
|---|---|
| `POST /api/users/:user/chat` | `{message, thread?, tz?}`; omit `thread` to start a new one |
| `GET /api/users/:user/notes[/:id]` · `POST …/notes` · `PUT`/`DELETE …/notes/:id` | notes as markdown: `{title?, body}` |
| `GET /api/users/:user/threads[/:thread]` | thread list, or one thread's transcript |
| `GET /api/users/:user/memory[/<path>]` | file list or one file (`?ref=` any commit) |
| `GET /api/users/:user/search?q=` | full-text search |
| `GET /api/users/:user/history[/:commit]` | commit log, or the files a commit changed |
| `POST /api/users/:user/dream` · `GET …/dream` | start a dream · status, last result, live log |
| `GET /api/users/:user/costs` | spend by chat and dreaming |

Set `MEMORY_API_KEY` for an admin key: `Authorization: Bearer <MEMORY_API_KEY>` reaches every user's `/api`.

## Auth

Cloudflare Access, single user. Enable it on the Worker's URL (Workers & Pages → the Worker → Settings → Domains & Routes → Enable Cloudflare Access) or add a self-hosted Access application for a hostname in your zone. The edge authenticates; the Worker verifies the `Cf-Access-Jwt-Assertion` JWT against your team's public keys and mints a session from the verified email — the user id derives from the email, so one identity is one memory repo, with no email infrastructure and no open sign-up.

Set `ACCESS_TEAM_DOMAIN` (e.g. `https://<team>.cloudflareaccess.com`) and `ACCESS_AUD` (the application's AUD tag, under Access → Applications → your app). Until both are set, the UI has no sign-in; the admin API below still works.

Machine agents don't sign in at all: set `MEMORY_API_KEY` and send `Authorization: Bearer <MEMORY_API_KEY>`, which reaches every user's `/api`.

One account can keep several memory banks (switch or create them from the top bar). `main` is the account's original memory and keeps its agent name (`<user>`); another bank is a separate agent and repo named `<user>.<bank>`. The bank list and the monthly spend cap live on the main agent, so the cap covers every bank. A session is an HMAC-signed token (signed with `AUTH_SECRET`, valid 30 days), set as an HttpOnly cookie for the UI and usable as a bearer token for the API. The Worker checks it before any request reaches `/agents/memory-agent/<user>` or `/agents/chat-agent/<user>.*`, so you can only open your own agents.

If the Worker also serves a workers.dev URL, put that behind Access too (or disable the route) — an unprotected URL would bypass Access.

## Layout

```
alchemy.run.ts            infra: Worker + Durable Objects + Artifacts namespace + secrets
src/server/
  memory.ts               the technique: conventions, chat tools, dreaming (no Cloudflare code)
  chat-agent.ts           a conversation: one turn = MEMORY.md + tools + streamText
  memory-agent.ts         a user: repo, commits, dreaming alarm, search, cost ledger
  vault.ts                Artifacts reads + isomorphic-git commit/push (cached working copy)
  shell.ts                just-bash over the repo (read-only for chat, writable for dreams)
  transcripts.ts          chat → timestamped transcripts, inbox for dreams, source excerpts
  models.ts               open-weight model list, Workers AI, per-call cost metering
  api.ts                  HTTP API (/api/users/:user/…) over the same agents
  auth.ts                 Cloudflare Access JWT → session cookie / bearer token
src/web/                  React UI (chat, notes editor, memory explorer, history, dream log, ⌘K search)
```

To change how the agent behaves, edit `AGENT_PROMPT` and the conventions in `src/server/memory.ts`.

## Caveats

- **Single user.** Sign-in is Cloudflare Access, not email — anyone outside your Access policy is out. Each user's model spend is capped per calendar month (UTC; `MONTHLY_SPEND_CAP_USD` in `memory-agent.ts`): past it, chat refuses with "usage limit reached" and dreams are skipped.
- **Cost of writing as you go.** A message with something worth remembering costs a few extra steps (search, then edit). Dreams cost more as memory grows: the dreamer re-reads what's there before writing.
- **Grep, not embeddings.** Recall depends on the agent searching with the right words. Aliases in entries help.

## Credits

- [Cognition, "Agent memory repo"](https://cognition.com/agent-memory-repo): the technique.
- [Quartz](https://quartz.jzhao.xyz) (MIT): the graph view is a port of its renderer (`src/web/quartzGraph.ts`).
- [Pierre](https://pierre.computer): `@pierre/trees` and `@pierre/diffs`.
- [Novel](https://novel.sh) + [tiptap-markdown](https://github.com/aguingand/tiptap-markdown): the notes editor, set up after [notty](https://github.com/Dhravya/notty).

## License

MIT
