<p align="center">
  <img src="logo.jpg" alt="LearnSphere AI" width="120" />
</p>

<h1 align="center">LearnSphere AI</h1>

<p align="center"><strong>Study from your own material, with a tutor that cites its sources.</strong></p>

<p align="center">
  <a href="https://ai-builders-congress-2026.netlify.app/"><img alt="Live demo" src="https://img.shields.io/badge/live_demo-open-2ea44f?style=flat-square" /></a>
  <a href="https://ai-builders-congress-2026.onrender.com/api/health"><img alt="API" src="https://img.shields.io/badge/API-health-46a2f1?style=flat-square" /></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520.11-339933?style=flat-square&logo=node.js&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/react-19-61dafb?style=flat-square&logo=react&logoColor=black" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-321_passing-2ea44f?style=flat-square" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
</p>

<p align="center">
  International AI Builders Congress 2026 · Challenge: <strong>AI Teacher</strong> · Team <strong>NITER_Parallax</strong>
</p>

---

## Live demo

| What | URL |
| --- | --- |
| **Web app** | https://ai-builders-congress-2026.netlify.app/ |
| **API** | https://ai-builders-congress-2026.onrender.com |
| **Health check** | https://ai-builders-congress-2026.onrender.com/api/health |

> The API runs on a free Render instance, so the first request after a quiet period can take
> up to ~30 seconds while it wakes. The SPA and API are separate services; the site proxies
> `/api/*` to Render through a Netlify Function.

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
              │  /api/*   (same origin; Netlify Function proxies to Render)
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
│  Storage                   │  JSON collections + uploaded files + extracted passages
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
| Auth | scrypt password hashes, HttpOnly session cookies, session-bound CSRF token |
| Hosting | Netlify (SPA + function proxy) and Render (API + persistent disk) |

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
| `npm run team:set-password` | Reset the five team accounts in place |

Upload the files in `samples/` from **My Materials** to try it immediately — they cover every
supported format, including Bangla PDF/Word/RTF examples. See [`samples/README.md`](samples/README.md).

## Project structure

```text
learnsphere-ai/
├── server/                  Express API
│   ├── src/
│   │   ├── ai/              provider chain, prompts, teacher, instructions
│   │   ├── auth/            accounts, sessions, team allowlist
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
├── netlify/functions/       same-origin `/api/*` proxy
├── scripts/                 dev runner, sample generator, team password reset
├── samples/                 generated demo material (8 formats)
├── render.yaml              API deployment (Render)
└── netlify.toml             SPA deployment (Netlify)
```

## Configuration

Copy `.env.example` to `.env`. Every value is optional; the app runs without configuration.
The full annotated list is in [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `NODE_ENV` | `development` | `production` also switches the `AUTH_MODE` default |
| `AUTH_MODE` | `required` in production, `local` otherwise | identity mode (see below) |
| `SESSION_TTL_DAYS` | `14` | account session lifetime |
| `AUTH_RESET_TTL_MINUTES` | `30` | password-reset token lifetime |
| `AUTH_DEV_RESET` | on outside production | return the one-time reset token to the page; `0` disables |
| `AUTH_REGISTRATION_POLICY` | `allowlist` | `allowlist` (five team addresses) or `open` |
| `TEAM_BOOTSTRAP_PASSWORD` | — | shared password for the five authorised accounts |
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

Two identity modes, chosen with `AUTH_MODE`:

| Mode | Intended use | Identity |
| --- | --- | --- |
| `local` (development default) | one student on one machine, demo, judging | a browser-asserted study profile (`X-Learner-Id`) |
| `required` (production default) | any public or shared deployment | a server-verified account session |

**`local` is not authentication.** The profile id is sanitised and every store query filters on
it, but anyone who can reach the API can send any profile id. Settings and `/api/health` say this
explicitly, and the server logs a warning at startup.

In `required` mode:

- Registration and sign-in live at `/api/auth/*`. Passwords are hashed with **scrypt** and a
  per-user random salt (minimum 10 characters).
- The session is a random 32-byte token in an **HttpOnly, SameSite=Lax** cookie. Only a SHA-256
  digest of the token is stored, so a copy of the data directory cannot be replayed as a login.
- Every API route except `/api/health`, `/api/config` and `/api/auth/*` answers **401** without a
  session, and the account id — not any request header — decides whose rows are read or written.
- Signing out deletes the session server-side and clears the cookie. Signing in rotates the
  session: the pre-login token stops working immediately.
- State-changing requests must echo the session-bound CSRF token (`ls_csrf` cookie →
  `X-CSRF-Token` header). Requests without it answer `403 csrf_failed`.
- The frontend is route-driven: `/` is a public welcome page, `/login`, `/signup` and `/reset` are
  real forms, `/onboarding` is shown once to a new account, and any other route redirects a
  signed-out visitor to `/login?next=<path>`.
- `/api/account` exposes the profile, a JSON export of the caller's own data, and deletion.
  Export never contains a password hash; deletion requires the account password and removes every
  owned row and file.
- Password reset is a single-use, hashed, 30-minute token. **No email provider is bundled**, so on
  non-production deployments the token is returned to the page (labelled as a development token;
  `AUTH_DEV_RESET=0` disables it). Production must configure delivery.

### Authorised accounts

This deployment is invitation-only. Five team addresses may hold an account, and the list lives
on the server (`server/src/auth/team.js`) — it is never sent to the browser, so a visitor cannot
enumerate who has access.

- `AUTH_REGISTRATION_POLICY=allowlist` (default) accepts a sign-up only for those addresses and
  registers the person under their team name. `open` accepts any address.
- The shared team password is configuration, not source: it is read from
  `TEAM_BOOTSTRAP_PASSWORD` in `.env` (git-ignored) with no built-in fallback. Quote it if it
  contains `#`.
- `npm run team:set-password` updates the five accounts **in place** (same ids, profile, materials,
  progress, plans and sessions), gives each its own scrypt hash, and clears `mustChangePassword`.
- Provisioning at startup is non-destructive: it creates missing accounts and never touches an
  existing one. The first-login gate (`403 password_change_required`) applies to accounts flagged
  `mustChangePassword`; `POST /api/account/password` verifies the current password, clears the
  flag and revokes every session.

Local-mode data is **not** silently migrated into an account; the two are separate learners by
design.

## Data and backups

All state lives under `LEARNSPHERE_DATA_DIR` (default `server/data/`, ignored by Git):

- JSON collections: `materials`, `sessions`, `quizzes`, `attempts`, `flashcard-decks`,
  `flashcard-reviews`, `studio-visuals`, `learning-paths`, `study-plans`, `users`,
  `auth-sessions`, `password-resets`
- `raw/` — the uploaded files
- `chunks/` — extracted passages per material

Writes are serialised per file and committed with a temp file + rename, so a crash cannot leave
truncated JSON (`server/test/storage.queue.test.js` covers it). `render.yaml` mounts a persistent
disk at `/var/data`; without one, uploads are lost when the service restarts. Back up by copying
that directory while the service is stopped. A single instance is supported; multiple instances
would need shared storage and a shared rate-limit store.

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
npm test           # 321 tests
npm run test:eval  # 10 grounded-answer evaluations
npm run build      # production bundle
```

`npm test` boots the real Express app against a temporary data directory (no mocks) and covers
retrieval, grounding, uploads, quizzes, flashcards, the review queue, DNA, coach, study plans,
account isolation, rate limiting, CORS, secret handling and the Netlify proxy contract.
`npm run build` is also required before the "no key in the bundle" test can inspect `web/dist`.

## Deployment

The SPA and the API deploy separately, and the live instances are:

| Service | URL |
| --- | --- |
| Netlify (SPA + `/api/*` proxy) | https://ai-builders-congress-2026.netlify.app/ |
| Render (Express API) | https://ai-builders-congress-2026.onrender.com |

1. **Render** — `render.yaml` runs `npm ci` and `npm run start --workspace server`, health-checks
   `/api/health`, and mounts the persistent disk described above.
2. **Netlify** — build with `npm run build`, publish `web/dist`, and route `/api/*` through
   `netlify/functions/api.mjs` to the backend. The proxy forwards multiple `Set-Cookie` headers,
   so account sessions work through it, gives the upstream 9 seconds
   (`LEARNSPHERE_PROXY_TIMEOUT_MS`, capped below Netlify's 10-second limit), and returns a
   retryable `backend_timeout` after that.

Set `LEARNSPHERE_BACKEND_URL` in Netlify (scope: **Functions**) when the backend is not the
default. A folder-only static deploy does not include functions; deploy the repository.

**For any public deployment:** set `AUTH_MODE=required`, set `CORS_ALLOWED_ORIGINS` to the site's
exact origin, keep `TRUST_PROXY=0` unless a known proxy is in front, and give the service a
persistent disk. `netlify.toml` deliberately keeps the secrets scanner enabled for
`LEARNSPHERE_AI_API_KEY`.

Long AI generations can exceed the proxy's 9-second budget; the failure is a clear, retryable
`backend_timeout`. Retrying is safe because the API writes nothing (quiz, attempt, message) until
a request succeeds.

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
- **No asynchronous AI job queue.** Requests are synchronous, bounded by the provider timeout and,
  behind the Netlify proxy, by the 9-second upstream budget.
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

In production the web app is account-protected; team accounts are provisioned from `.env`.
`AUTH_MODE=local` is the single-profile demo mode and is not authentication.
