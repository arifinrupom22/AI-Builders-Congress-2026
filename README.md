<p align="center">
  <img src="logo.jpg" alt="LearnSphere AI" width="120" />
</p>

<h1 align="center">LearnSphere AI</h1>

<p align="center"><strong>Study from your own material, with a tutor that cites its sources.</strong></p>

<p align="center">
  <a href="https://ai-builders-congress-2026.onrender.com/"><img alt="Live demo" src="https://img.shields.io/badge/live_demo-open-2ea44f?style=flat-square" /></a>
  <a href="https://ai-builders-congress-2026.onrender.com/api/health"><img alt="API" src="https://img.shields.io/badge/API-health-46a2f1?style=flat-square" /></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520.11-339933?style=flat-square&logo=node.js&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/react-19-61dafb?style=flat-square&logo=react&logoColor=black" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-349_passing-2ea44f?style=flat-square" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
</p>

<p align="center">
  International AI Builders Congress 2026 · Challenge: <strong>AI Teacher</strong> · Team <strong>NITER_Parallax</strong>
</p>

---

## Live demo

| What | URL |
| --- | --- |
| **Web app** | https://ai-builders-congress-2026.onrender.com/ |
| **API** | https://ai-builders-congress-2026.onrender.com |
| **Health check** | https://ai-builders-congress-2026.onrender.com/api/health |

> One Render service serves the React app and the API on the same origin, so there is no
> cross-origin proxy in the path. It runs on a free instance: the first request after a quiet
> period can take up to ~30 seconds while it wakes, and a request that arrives before the
> instance is awake fails with a retryable timeout.

## The short version

LearnSphere AI is a source-grounded study assistant. Upload your own PDFs, notes or slides and
it becomes a tutor for **that material**: every answer cites the document, page and passage it
used, and when your files do not cover a question it says so and answers from general knowledge
instead of inventing a citation.

- **Grounded by default** — retrieval, citations, summaries, flashcards, quizzes and the study
  plan are built from your uploads, not from a model's memory.
- **Works offline** — with no AI key configured, the whole app still runs on a deterministic
  local engine. Extraction, BM25 retrieval, citations and quiz generation never call the network.
- **Bangla and English** — Bangla script, Banglish and English questions are understood, and the
  answer follows the language you asked in.
- **Honest about limits** — no grade prediction, no "mastery" claims, and current-affairs
  questions get an explicit freshness caveat instead of a confident stale fact.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [The AI Teacher](#the-ai-teacher)
- [Quick start](#quick-start)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Firebase and Supabase setup](#firebase-setup)
- [Accounts and security](#accounts-and-security)
- [Data and backups](#data-and-backups)
- [API](#api)
- [Testing](#testing)
- [Deployment](#deployment)
- [Privacy](#privacy)
- [Rotating a leaked API key](#rotating-a-leaked-api-key)
- [Limitations](#limitations)
- [Built with](#built-with)
- [Team and licence](#team-and-licence)
- [Demo walkthrough](#demo-walkthrough)

## Features

| Area | What it does |
| --- | --- |
| **AI Teacher** | Cited answers from your material, multi-turn follow-ups, honest general-knowledge answers when your files do not cover it. |
| **My Materials** | PDF, DOCX/DOC, RTF, ODT, Markdown and plain text. The extraction result (pages, warnings, character count) is shown for every upload. |
| **Study summary** | Revision notes built from your documents, with the same source citations. |
| **Visual Study Studio** | Concept maps, flowcharts, tables and timelines generated from the material, each traceable to a passage. |
| **Learning path** | A step-by-step route through the topics your material actually covers. |
| **Practice** | Quizzes generated from your own documents: definitions, recognition questions, or a mix. Scores are practice feedback, never a predicted grade. |
| **Flashcards & review** | Every card cites its source; the review queue is derived from your own ratings. |
| **Progress & Learning DNA** | An evidence profile of recorded attempts and ratings, with the counts behind each claim. |
| **Exam coach** | The next thing to practise, with the reason and the evidence shown. |
| **Study plan** | A syllabus mapped to your files, a daily schedule you can edit/pause/complete, and explicit gaps where nothing matched. |
| **Accounts** | Server-verified sessions, per-user data isolation, JSON export and account deletion. |

## How it works

```text
┌────────────────────────────┐
│  React SPA (Vite)          │  routes, chat, quiz player, plan editor
└─────────────┬──────────────┘
              │  /api/*   (same origin)
┌─────────────▼──────────────┐
│  Express 5 API             │  auth, rate limits, CSRF, validation (Zod)
├────────────────────────────┤
│  BM25 retrieval            │  per-learner index, score threshold, passage metadata
│  Citation verification     │  strips citations that were not actually supplied
├────────────────────────────┤
│  AI provider chain         │  Groq → Gemini → Gemini, or the deterministic local engine
└─────────────┬──────────────┘
              │
┌─────────────▼──────────────┐
│  Storage                   │  Supabase (Postgres + Storage) or local JSON collections
└────────────────────────────┘
```

| Layer | Technology |
| --- | --- |
| Frontend | React 19, Vite 8, hand-written CSS (light/dark themes) |
| Backend | Node.js ≥ 20.11, Express 5 |
| Retrieval | In-house BM25 with Bangla/Banglish tokenisation |
| Documents | `pdfjs-dist`, in-house DOCX/ODT/RTF/legacy-DOC readers |
| Validation | Zod schemas on every mutating endpoint |
| AI | Groq / Gemini / OpenRouter / Mistral / Cloudflare, with a local fallback |
| Auth | Firebase Authentication (email/password, email verification); ID tokens verified server-side |
| Data | Supabase PostgreSQL + private object storage (JSON files for local development) |
| Hosting | Render (SPA + API on one origin) |

### How answers stay grounded

1. Text is extracted from the upload and split into passages that keep document, page and
   heading metadata.
2. A per-learner BM25 index is built from **that learner's ready documents only**. The learner
   filter is applied when the index is built, so a crafted query cannot reach another account's
   passages.
3. A passage is used only when its IDF-weighted query-term coverage reaches the configured
   threshold. Below it, the teacher refuses instead of answering from a weak match.
4. Citations are verified against the passages that were actually supplied; invented citations
   are stripped before display.

There is **no separate "reasoning model" grading answers**. When a live provider is configured it
writes the wording of an answer or a quiz; correctness for quizzes is decided by the stored
answer key, and diagnostics are deterministic summaries of recorded answers. No component
estimates ability, predicts a grade, or claims mastery or learning gain.

## The AI Teacher

### Conversation memory and follow-ups

Each question is sent with the last few turns of the session. A short continuation ("aro bolo",
"eta bujhlam na", "example dao", "why?", "explain more") is treated as a follow-up: retrieval
re-runs on the previous question plus the new text, and the prompt tells the model to add new
detail instead of restating the previous answer. A follow-up also inherits the language of the
turn it continues, so a Bangla conversation does not flip to English because "aro bolo" is typed
in Latin letters.

Answers are normalised after generation: a Bangla answer gets Bangla section headings instead of
the English template, invisible zero-width joiners from copied Bangla text are removed, and stray
LaTeX escapes (`\(N\)`) are cleaned up. The body is never rewritten.

### Languages

A question written in Bangla script gets a Bangla answer. **Banglish** ("photosynthesis ki vabe
hoy", "Bangla e bujhao") is Bangla in Latin letters, so it also gets a Bangla answer; the tutor
prompt says so explicitly, because Latin letters alone used to be read as English. Retrieval
strips Banglish function words and expands known spelling variants, so a Banglish question can
still match English notes.

### Questions about current events

The model has no browsing and its training data has a cutoff, so "who is the prime minister now?"
or "was there a lockdown today?" is flagged as time-sensitive before generation. The prompt then
forbids naming any current office-holder or asserting a "today" fact, and the response carries a
`time_sensitive_unverified` warning plus provenance that says the information may be out of date.
The answer explains only the parts that do not change and points to a live source. Live news is
**not** fetched — see [Limitations](#limitations).

### Provider chain

Set `LEARNSPHERE_AI_FALLBACK1_PROVIDER` and `LEARNSPHERE_AI_FALLBACK1_API_KEY` (up to three slots,
`FALLBACK2`, `FALLBACK3`) and a failing primary is skipped instead of failing the request: a
rate-limited Groq key hands over to a Gemini key, a bad key moves on immediately without burning
quota, and a 5xx is retried a few times first. The answer is tagged with the provider that
produced it, so the transcript and the logs say which key answered. If every provider fails, the
deterministic local teacher answers and the student is told what broke — the AI Teacher never
shows an error page for a provider outage.

## Quick start

Requires **Node.js ≥ 20.11.0**.

```bash
git clone <your-repo-url> learnsphere-ai
cd learnsphere-ai
npm install
npm run dev
```

`npm run dev` starts the API on `http://localhost:8787` and the web app on
`http://localhost:5173` (ports auto-advance if taken). No configuration is required: with no AI
key the app runs in offline demo mode.

| Command | What it does |
| --- | --- |
| `npm run dev` | API + Vite dev server together |
| `npm run build` | Production web bundle in `web/dist` |
| `npm start` | Serve the API and the built SPA from one process |
| `npm test` | Full server suite against a real Express app |
| `npm run test:eval` | Offline grounded-answer evaluation set |
| `npm run samples:seed` | Regenerate the sample study files in `samples/` |

Upload the files in `samples/` from **My Materials** to try it immediately — they cover every
supported format, including Bangla PDF/Word/RTF examples. See [`samples/README.md`](samples/README.md).

## Project structure

```text
learnsphere-ai/
├── server/                  Express API
│   ├── src/
│   │   ├── ai/              provider chain, prompts, teacher, instructions
│   │   ├── auth/            accounts, sessions, Firebase token verification
│   │   ├── documents/       PDF, Word, ODT, RTF, text extraction
│   │   ├── retrieval/       tokenisation and BM25 index
│   │   ├── quiz/            grounded quiz generation
│   │   ├── flashcards/      cards, scheduling, review queue
│   │   ├── planner/         study plan generation and refresh
│   │   ├── routes/          HTTP endpoints
│   │   └── storage/         atomic JSON collections
│   └── test/                API, retrieval, security and evaluation suites
├── web/                     React SPA (Vite)
│   ├── src/pages/           dashboard, chat, materials, quiz, plan, settings…
│   ├── src/components/      shell, brand, shared UI
│   └── src/styles/          public and app themes
├── scripts/                 dev runner, sample generator
├── samples/                 generated demo material (8 formats)
├── supabase/migrations/    PostgreSQL schema, indexes and RLS
├── server/src/auth/firebase.js  Firebase ID-token verification
├── server/src/storage/supabase.js  Supabase adapters (records, passages, Storage)
└── render.yaml              web app + API deployment (Render)
```

## Configuration

Copy `.env.example` to `.env` in the repository root. Every value is optional; the app runs
without configuration. The full annotated list is in [`.env.example`](.env.example).

That one file is read by both sides: the server loads it with dotenv, and `web/vite.config.js` is
configured with `envDir` pointing at the repository root, so the `VITE_FIREBASE_*` web config is
found during a build. Vite still inlines only `VITE_`-prefixed values, so every other key stays
on the server.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `NODE_ENV` | `development` | `production` also switches the `AUTH_MODE` default. Set it in the process environment, **not** in `.env`: Vite reads `.env` during a build and would ship React's development bundle |
| `AUTH_MODE` | `required` in production, `local` otherwise | identity mode (see below) |
| `SESSION_TTL_DAYS` | `14` | account session lifetime |
| `AUTH_RESET_TTL_MINUTES` | `30` | password-reset token lifetime |
| `AUTH_DEV_RESET` | on outside production | return the one-time reset token to the page; `0` disables |
| `AUTH_REGISTRATION_POLICY` | `open` | `open` (anyone may sign up) or `closed` (no new accounts) |
| `FIREBASE_PROJECT_ID` | — | enables Firebase ID-token verification; the provider becomes Firebase |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | — | enables the Supabase data store (server-side only) |
| `SUPABASE_STORAGE_BUCKET` | `materials` | private bucket for uploaded originals |
| `VITE_FIREBASE_*` | — | build-time Firebase web config (public) |
| `TRUST_PROXY` | `0` | reverse-proxy hops to trust for `req.ip` |
| `CORS_ALLOWED_ORIGINS` | — | comma-separated origins allowed to call the API |
| `LEARNSPHERE_DATA_DIR` | `server/data` | storage directory |
| `LEARNSPHERE_AI_PROVIDER` | `none` | `none`, `groq`, `gemini`, `openrouter`, `mistral`, `cloudflare`, `custom` |
| `LEARNSPHERE_AI_API_KEY` | — | server-side only; never sent to the browser |
| `LEARNSPHERE_AI_MODEL` | provider default | model id |
| `LEARNSPHERE_AI_FALLBACK{1..3}_*` | — | ordered fallback providers |
| `AI_TIMEOUT_MS` | `45000` | per-attempt provider timeout |
| `RATE_LIMIT_PER_MINUTE` | `120` | per-profile ceiling; the per-IP ceiling is 4× this |
| `MAX_UPLOAD_MB`, `MAX_DOCUMENTS`, `RETRIEVAL_TOP_K`, `RETRIEVAL_MIN_SCORE` | see `.env.example` | limits and retrieval tuning |

## Accounts and security

Identity has two layers, and they are deliberately separate:

| Layer | Owner | What it proves |
| --- | --- | --- |
| **Firebase Authentication** | Firebase | who the person is (email verified, ID token signed by Firebase) |
| **Application data** | this server + Supabase | which rows that person may read or write |

Supabase Auth is **not** used anywhere. Firebase is the only identity provider.

### Identity modes

`AUTH_MODE` still selects what the deployment expects:

| Mode | Intended use | Identity |
| --- | --- | --- |
| `local` (development default) | one student on one machine, demo, judging | a browser-asserted study profile (`X-Learner-Id`) |
| `required` (production default) | any public or shared deployment | a verified Firebase ID token (when Firebase is configured, a cookie session is ignored) |

**`local` is not authentication.** The profile id is sanitised and every store query filters on it,
but anyone who can reach the API can send any profile id. Settings and `/api/health` say this
explicitly, and the server logs a warning at startup.

### Firebase Authentication

When `FIREBASE_PROJECT_ID` is set on the server and the `VITE_FIREBASE_*` web config is present at
build time, accounts are created and signed in through Firebase:

- **Create account** — the existing sign-up form calls Firebase Email/Password, sets the display
  name, and sends a verification link. The new account is then signed out immediately, so an
  unverified account never holds a session.
- **Email verification** — the server refuses an unverified token with `403 email_not_verified`.
  The UI shows "verify your email, then sign in" instead of a half-working account.
- **Login** — Firebase authenticates, the browser sends the ID token as
  `Authorization: Bearer <idToken>`, and the server verifies it before touching any data.
- **Logout** — Firebase clears its session and the server also drops any legacy cookie session.
- **Password reset** — the existing Forgot-password form calls Firebase's reset email when
  Firebase is configured. No reset token is ever shown on the page in that mode.
- **Resend and re-check** — an unverified account cannot sign in, so the sign-in screen offers
  "Resend verification email" and "I have verified my email". Both use the password already typed
  in the form, act on a session that is dropped again immediately, and report Firebase's own error
  when the send is refused (quota, rate limit, network).
- **Password endpoints closed** — with `FIREBASE_PROJECT_ID` set, `/api/auth/register`, `/login` and
  the password-reset routes answer `403 firebase_identity_required`. Otherwise they could mint a
  session that no email verification ever approved, and an account Supabase would key to a
  non-Firebase owner id.

Server-side verification (`server/src/auth/firebase.js`) is dependency-free: it pins `alg` to
RS256, selects Google's published certificate by `kid`, verifies the signature, checks `aud`,
`iss`, `exp`, `iat` and a non-empty `sub`, and only then treats the token as an identity. A token
that fails any check is rejected with `401 invalid_token` — the server never falls back to a
client-supplied uid.

The account row is created on the first verified request and keyed by the Firebase UID. A later
sign-in updates only `emailVerified` and the display name, so the account id — and therefore every
row it owns — stays stable.

### Registration and email verification

The account system starts clean: there is no seeded account, no invitation list and no default
password anywhere in the repository or the environment.

1. **Create account** — a visitor opens `/signup` and enters a name, email and password. The form
   calls Firebase Email/Password, sets the display name and asks Firebase to send a verification
   link. The new account is signed out immediately, so an unverified account never holds a session.
2. **Verify** — the person follows the link in that email. Until they do, the server refuses their
   token with `403 email_not_verified` and the UI keeps them on the verification screen instead of
   showing a half-working account. The same screen, and the sign-in error, offer **Resend
   verification email** and **I have verified my email**.

   If Firebase refuses the send (daily quota, rate limit, network), the account still exists and the
   screen says so: it is reported as a resend problem, never as a failed sign-up, because retrying
   the sign-up itself can only fail with `auth/email-already-in-use`.
3. **Sign in** — Firebase authenticates, the browser sends the verified ID token as
   `Authorization: Bearer <idToken>`, and the server verifies it before touching any data. The
   account row is created on that first verified request and keyed by the Firebase UID, so it is
   stable for the life of the account.
4. **Store** — the profile and every owned row (materials, passages, sessions, quizzes, attempts,
   flashcard decks and reviews, visuals, learning paths, study plans) live in Supabase with
   `owner_id` set to that Firebase UID. The service-role backend filters every read and write by the
   UID from the verified token, so two accounts can never see each other's rows.

Registration can be closed on a deployment with `AUTH_REGISTRATION_POLICY=closed`; accounts that
already exist keep signing in. There is no email-based adoption of an older account row: an account
is only ever the Firebase UID that signed up for it.

### Sessions, CSRF and route protection

- Firebase requests are bearer-token requests: no ambient cookie, so no CSRF token is required —
  and the server ignores the CSRF header for them.
- Legacy password sessions remain a random 32-byte token in an **HttpOnly, SameSite=Lax** cookie;
  only its SHA-256 digest is stored. State-changing cookie requests must echo the session-bound
  CSRF token (`ls_csrf` → `X-CSRF-Token`), otherwise `403 csrf_failed`.
- Every API route except `/api/health`, `/api/config` and `/api/auth/*` answers **401** without a
  verified identity. The account id comes from the verified token or the session record — never
  from a request header or body.
- The frontend is route-driven: `/` is a public welcome page, `/login`, `/signup` and `/reset` are
  real forms, `/onboarding` is shown once to a new account, and any other route redirects a
  signed-out visitor to `/login?next=<path>`.
- `/api/account` exposes the profile, a JSON export of the caller's own data, and deletion.
  Export never contains a password hash; deletion removes every owned row and file.

### Secrets

| Value | Where it lives | Never |
| --- | --- | --- |
| `VITE_FIREBASE_*` | build-time web config (public by design) | — |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | server environment | browser, repository |
| `SUPABASE_URL` | server environment | — (public, but only used server-side) |
| `SUPABASE_SERVICE_ROLE_KEY` | server environment | browser, repository, logs |

The service-role key bypasses Row Level Security, so it exists only in the server process. The
frontend never receives it, and a test asserts that no configured secret appears in `web/dist`.
## Data and backups

Application data has one driver, chosen at startup by `server/src/storage/index.js`:

| Configuration | Driver | Use |
| --- | --- | --- |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set | **Supabase** (PostgreSQL + Storage) | production, shared deployments |
| otherwise | JSON collections under `LEARNSPHERE_DATA_DIR` | local development, tests, offline demo |

A configured-but-unreachable Supabase stops the server at startup instead of silently writing to
local disk, so a deployment can never end up with half its data in a different store.

### Supabase schema

`supabase/migrations/0001_init.sql` creates everything, and is safe to re-run.

| Object | Purpose |
| --- | --- |
| `records(collection, id, owner_id, data jsonb, created_at, updated_at)` | every application entity, one row each. `collection` names the type: `users`, `materials`, `sessions`, `quizzes`, `attempts`, `flashcard-decks`, `flashcard-reviews`, `studio-visuals`, `learning-paths`, `study-plans`, `auth-sessions`, `password-resets`. `owner_id` is the account id (the Firebase UID for Firebase accounts); account rows have no owner. |
| `material_passages(material_id, position, data jsonb)` | extracted, citable passages per uploaded document, read by material in page order |
| `profiles` (view) | account rows flattened for reporting: user id, Firebase UID, email, display name, provider |
| storage bucket `materials` | the uploaded originals, private, 20 MB per file |

Indexes cover the access paths the API actually uses: by collection, by owner, by collection +
owner, by `updated_at`, plus a GIN index on `data` and **unique** indexes on the Firebase UID and on
the lower-cased `emailKey`, so two accounts can never claim one identity or one address.

`data` holds the entity exactly as the API produces it. That is a deliberate choice: the tested
learning logic (retrieval, quizzes, flashcards, planning, progress) is unchanged, so its behaviour
cannot drift when the database changes, and a schema migration can normalise fields later without
touching a single feature.

The server implements this through two small adapters (`server/src/storage/supabase.js`): a
collection with `read()` / `update(mutator)` over `records`, and blob storage over
`material_passages` + the private bucket. The rest of the store — every ownership filter, every
"does this row belong to this learner" check — is the same code that runs against local files.

### User isolation and RLS

- Every store query is filtered by the identity resolved from the verified ID token (or the legacy
  session). A caller cannot pass another account's id: the server derives it, it is never an input.
- Row Level Security is **enabled** on `records` and `material_passages`, and `anon` /
  `authenticated` are revoked, so a leaked anon key reads nothing.
- The service-role key bypasses RLS by design. That is why the API checks ownership itself instead
  of assuming the database will.
- No permissive policy is defined for `anon` or `authenticated`: `auth.jwt()` belongs to Supabase
  Auth and a Firebase ID token never populates it, so a claim-based policy would be dead code. Only
  deny rules exist. `service_role` still needs table privileges even though it bypasses RLS, so the
  migration grants exactly the ones the store uses.
- Uploaded files are in a **private** bucket. They are only read through the API, after the same
  ownership check, and never exposed as a public URL.

### Migrating existing data

Nothing is moved automatically. The JSON collections and the Supabase tables are separate drivers,
and a deployment uses exactly one of them. To carry existing files into Supabase:

1. Apply the migration: `supabase db push` (or paste the SQL into the dashboard).
2. For each collection file in `LEARNSPHERE_DATA_DIR` (`materials.json`, `sessions.json`, …, `users.json`),
   insert rows with `collection` set to the file name without `.json` and `owner_id` set to the
   row's `learnerId` (`users`, `auth-sessions`, `password-resets` have no owner).
3. Upload each file in `raw/` to the `materials` bucket under the material id.
4. Insert each `chunks/<material-id>.json` array into `material_passages` with `position` as the
   array index.

Account rows are keyed by the Firebase UID. A fresh deployment starts with no account rows at all:
the first row for a person is created by their own verified Firebase sign-up.

### Local JSON layout (development driver)

- JSON collections: `materials`, `sessions`, `quizzes`, `attempts`, `flashcard-decks`,
  `flashcard-reviews`, `studio-visuals`, `learning-paths`, `study-plans`, `users`,
  `auth-sessions`, `password-resets`
- `raw/` — the uploaded files
- `chunks/` — extracted passages per material

Writes are serialised per file and committed with a temp file + rename, so a crash cannot leave
truncated JSON (`server/test/storage.queue.test.js` covers it). Back up by copying that directory
while the service is stopped. A single instance is supported; multiple instances would need shared
storage and a shared rate-limit store.

## API

All routes are JSON and require a session in `required` mode (except the public ones noted).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Status, provider chain, store counts (public) |
| `GET` | `/api/config` | Public UI configuration (public) |
| `POST` | `/api/auth/register`, `/login`, `/logout` | Account lifecycle |
| `POST` | `/api/auth/password-reset/request`, `/confirm` | Password reset |
| `GET`/`POST` | `/api/materials` | List / upload study material |
| `GET`/`DELETE` | `/api/materials/:id` | One material, its passages, deletion |
| `POST` | `/api/chat` | Ask the AI Teacher (mode, length, material scope, session) |
| `GET` | `/api/chat/sessions`, `/api/chat/sessions/:id` | Conversation history |
| `POST` | `/api/summary` | Cited revision notes |
| `POST` | `/api/visuals/generate` | Concept map, flowchart, table or timeline |
| `POST` | `/api/learning-path/generate` | Step-by-step path |
| `POST` | `/api/quiz/generate` | Generate a grounded quiz |
| `POST` | `/api/quiz/:id/submit` | Submit answers, receive explanations with sources |
| `POST` | `/api/flashcards/generate` | Generate cards from material |
| `GET` | `/api/flashcards/due` | Review queue |
| `POST` | `/api/flashcards/:id/review`, `/snooze` | Record a rating / defer a card |
| `GET` | `/api/progress`, `/api/dna`, `/api/coach` | Evidence profile and next practice |
| `POST` | `/api/plan` | Create a study plan from a syllabus |
| `PATCH` | `/api/plan/:id` | Edit schedule settings |
| `PATCH` | `/api/plan/:id/tasks/:taskId` | Mark done / pause / resume |
| `GET` | `/api/account/export` | Export the caller's data |
| `DELETE` | `/api/account` | Delete the account and its data |

## Testing

```bash
npm test           # 349 tests (337 server + 12 web)
npm run test:eval  # 10 grounded-answer evaluations
npm run build      # production bundle
```

`npm test` boots the real Express app against a temporary data directory (no mocks) and covers
retrieval, grounding, uploads, quizzes, flashcards, the review queue, DNA, coach, study plans,
account isolation, Firebase token verification, rate limiting, CORS and secret handling.
`npm run build` is also required before the "no key in the bundle" test can inspect `web/dist`.

## Deployment

The Express server serves the API and the built SPA on **one origin**, so a single Render service is
the whole deployment:

| Service | URL | Serves |
| --- | --- | --- |
| Render | https://ai-builders-congress-2026.onrender.com | SPA + `/api/*` on one origin |
| Health check | https://ai-builders-congress-2026.onrender.com/api/health | provider chain, auth mode, store counts |

`render.yaml` runs `npm ci --include=dev && npm run build`, starts
`npm run start --workspace server`, health-checks `/api/health`, and mounts the persistent disk
described above. `--include=dev` is required: `NODE_ENV=production` is set for the build step too,
so npm would otherwise skip the devDependencies that Vite needs. The build writes `web/dist`, which
`server/src/app.js` serves, and `/api/*` is routed before the SPA fallback so an API path can never
be answered with `index.html`.

### Render environment variables

| Key | Value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | Set in `render.yaml`. Also selects `AUTH_MODE=required` as the default. |
| `LEARNSPHERE_DATA_DIR` | `/var/data/learnsphere` | Only used by the local JSON driver. With Supabase configured it is not read. |
| `AUTH_MODE` | `required` | Set in `render.yaml`; every API route except health, config and auth needs a verified identity. |
| `FIREBASE_PROJECT_ID` | e.g. `learnsphere-ai` | Enables Firebase ID-token verification. |
| `FIREBASE_CLIENT_EMAIL` | service-account email | Optional for token verification (the certificate is fetched from Google); required if you later use the Admin SDK. |
| `FIREBASE_PRIVATE_KEY` | service-account private key | Server-side only. Keep the `\n` escapes and wrap the value in double quotes. |
| `SUPABASE_URL` | `https://<project>.supabase.co` | Enables the Supabase driver. |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key | **Server-side only.** Never put it in a `VITE_` variable. |
| `SUPABASE_STORAGE_BUCKET` | `materials` | Optional; defaults to `materials`. |
| `CORS_ALLOWED_ORIGINS` | e.g. `https://<site>` | Optional now that the SPA is same-origin. |
| `LEARNSPHERE_AI_PROVIDER`, `LEARNSPHERE_AI_API_KEY`, `LEARNSPHERE_AI_MODEL` | `groq`, the key, `openai/gpt-oss-20b` | Optional; without them the app runs in local demo mode. |

Frontend Firebase values are **build-time** variables and must exist when `npm run build` runs:
`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`,
`VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`. They are
public by design; a build without them keeps the built-in password sign-in and never loads the
Firebase SDK.

**For any public deployment:** set `AUTH_MODE=required`, keep `TRUST_PROXY=0` unless a known proxy
is in front, and give the service a persistent disk when using the JSON driver.

### Firebase setup

1. Create a project at <https://console.firebase.google.com>.
2. **Authentication → Sign-in method → Email/Password → Enable.** Firebase sends the verification
   and reset emails itself; no mail provider is needed in this app.
3. **Project settings → Your apps → Web app** — register the app and copy the `firebaseConfig`
   values into the `VITE_FIREBASE_*` variables above.
4. **Authentication → Settings → Authorized domains** — add the Render host
   (`ai-builders-congress-2026.onrender.com`) and `localhost` for development.
5. **Authentication → Templates** — review the verification and password-reset wording and sender.
   The verification template must stay enabled. The app asks for the link to return to
   `/#/login?verified=1`; that continue URL only works when the host is listed under
   **Authorized domains** (step 4). If the project rejects it, the app retries without a continue
   URL, so the email is still delivered and Firebase shows its own "email verified" page.
6. **Project settings → Service accounts → Generate new private key** — copy `project_id` to
   `FIREBASE_PROJECT_ID` and keep the JSON file out of the repository.
7. Nothing needs to be seeded under **Authentication → Users**: each person creates their own
   account from `/signup` and verifies the email Firebase sends (see
   [Registration and email verification](#registration-and-email-verification)).

### Supabase setup

1. Create a project at <https://supabase.com>.
2. **SQL Editor** — paste `supabase/migrations/0001_init.sql` and run it (or `supabase db push` with
   the Supabase CLI). It is idempotent: re-running it re-applies the `service_role` grants and
   forces the bucket private.
3. Confirm the objects exist: `records`, `material_passages`, the `profiles` view, and the private
   `materials` storage bucket. Also confirm the backend role can use them: with the service-role
   key, `GET /rest/v1/records?select=id&limit=1` must answer `200 []`. A `403 permission denied`
   means the grant block has not run.
4. Confirm RLS: both tables show **RLS enabled** and no policy grants `anon` access.
5. **Project settings → API** — copy the project URL to `SUPABASE_URL` and the **service_role** key to
   `SUPABASE_SERVICE_ROLE_KEY` (Render → Environment). Do not use the anon key here.
6. Restart the service. The startup log prints `Supabase storage connected`; a bad URL or key stops
   startup with an explicit message instead of writing to local disk.

### Verifying a deployment

1. `GET /api/health` → `200` with `environment: production`, the provider chain and store counts.
2. `GET /` → `200 text/html`; the referenced `/assets/*.js` and `.css` return `200`.
3. Create an account → the verification email arrives → the link verifies it → signing in before
   verifying returns `403 email_not_verified`, and the sign-in screen offers **Resend verification
   email**. If the mail never arrives, check the spam folder, the Firebase project's daily email
   quota, and **Authentication → Templates**: the verification template must be enabled.
4. Sign in verified, upload a document, ask a question, refresh the page: the material and the chat
   are still there.
5. Sign out and sign in again: the same data is still there (this is what proves persistence).
6. Sign in as a second account: the first account's library is not visible.
7. With the service-role key set, search `web/dist` for its value: it must not appear.

## Privacy

- With no provider key, no study content leaves the machine. The only external request the
  interface makes is for its web fonts (Google Fonts); uploads, questions and generated answers
  stay local.
- With a provider, only the retrieved passages for one request are sent. Uploaded files are never
  sent whole, and the rest of the library is never sent.
- The API never logs question text, document content or keys. Request logs contain only method,
  path, status and duration.
- API responses are `Cache-Control: no-store`. Session cookies are HttpOnly and SameSite=Lax.
- Error messages are written for students and never include stack traces, filesystem paths or
  provider response bodies.

## Rotating a leaked API key

1. Revoke it in the provider dashboard (Groq, Google AI Studio, OpenRouter, Mistral or
   Cloudflare) and create a new one.
2. Put the new value in `.env` locally and in the host's environment variables (Render →
   Environment; never in a committed file). Redeploy or restart.
3. Confirm `.env` is ignored (`git check-ignore -v .env`) and purge the old value from any branch
   or history where it appears.
4. Run `npm test` — the secrets test fails if the configured key appears in `web/dist`, and checks
   that `.env.example` has blank placeholders.

Rotation is complete only when the old key is revoked at the provider.

## Limitations

Stated plainly so nobody plans around a feature that is not there:

- **No OCR.** Scanned/image-only PDFs extract no text; the upload is kept with an extraction
  warning and nothing is indexed, so those pages are reported as uncovered — never as covered.
- **No live web or news access.** Current-affairs questions get an explicit "I cannot verify this,
  check a live source" caveat instead of a guess; real-time grounding needs a search API key and
  is not wired in this build.
- **No offline/PWA mode and no voice input/output.**
- **No asynchronous AI job queue.** Requests are synchronous, bounded by the provider timeout.
- **Interface translation is partial.** Welcome, sign-in, sign-up, reset, onboarding, the
  navigation shell, appearance/language controls and account settings are translated between
  English and Bangla. Deep tool screens (quiz player, studio, plan editor) still use English
  labels; Bangla and English *material* is handled end to end.
- **No email delivery for password reset.** The flow is implemented and tested, but no mail
  provider is bundled; production needs a delivery integration.
- **Rate limiting is in-memory per process**, exact for one instance and indicative for more.
- **No spaced-repetition algorithm changes**: the review queue derives from the learner's own
  ratings, and the plan only links to it.
- The shared `local` profile is never treated as an account and is never shown to a signed-in
  account. In account mode the browser profile id is ignored by the server for identity.

## Built with

Product direction, testing and review by **team NITER_Parallax**. Implementation and documentation
were developed in an AI-assisted workflow — pair-programming with **Claude** (Anthropic) and
**Codebuff** — with every generated change reviewed against the running app and its test suite.

## Team and licence

- **Product**: LearnSphere AI
- **Team**: NITER_Parallax
- **Competition**: International AI Builders Congress 2026, Challenge: AI Teacher
- **Licence**: MIT — see [`LICENSE`](LICENSE)

© 2026 LearnSphere AI

## Demo walkthrough

A three-minute judging path through the product:

1. `npm install && npm run dev` — API on 8787, web on 5173. Without an AI key the teacher,
   quizzes, summaries, flashcards and the plan still work from the deterministic local engine.
2. Open **My Materials** and upload several files from `samples/` (PDF, DOCX, Markdown and Bangla
   text). The extraction result, page count and warnings are shown for each one.
3. Open **AI Teacher** and ask something the material answers, e.g. "What is a database
   transaction?". The answer cites document, page and passage, and the retrieval panel lists the
   passages used.
4. Ask a follow-up ("aro bolo", "example dao"). It stays on the same topic and keeps citations.
5. Ask something outside the material ("what is a hash table?") to see the general-knowledge
   label, then a current-affairs question ("who is the prime minister now?") to see the freshness
   caveat instead of a confident stale fact.
6. Generate a **Practice** quiz, rate a couple of **Flashcards** in **Due for review**, then paste
   a syllabus in **Study plan** to show topics mapped to uploaded files, the gaps, and a daily
   schedule that can be edited and paused.

In production registration is open: each person creates their own account from `/signup` and verifies the email Firebase sends.
`AUTH_MODE=local` is the single-profile demo mode and is not authentication.
