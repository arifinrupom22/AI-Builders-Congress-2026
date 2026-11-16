# LearnSphere AI

A source-grounded study assistant built for the International AI Builders Congress 2026
(Challenge: AI Teacher, team NITER_Parallax).

LearnSphere AI teaches from the material a student uploads. Retrieval, citations and the
fallback quiz generator run locally. A live model is optional, and when one is configured
only the passages retrieved for a single question are sent to it.

## Contents

- [What it does](#what-it-does)
- [How answers stay grounded](#how-answers-stay-grounded)
- [Accounts, identity and data isolation](#accounts-identity-and-data-isolation)
- [Storage and backups](#storage-and-backups)
- [Study plan](#study-plan)
- [Environment variables](#environment-variables)
- [Development and tests](#development-and-tests)
- [Deployment](#deployment)
- [Privacy](#privacy)
- [Rotating a leaked API key](#rotating-a-leaked-api-key)
- [What is not implemented](#what-is-not-implemented)
- [Team and licence](#team-and-licence)

## What it does

- **AI Teacher** — ask about your own material; every answer cites the document, page and
  passage it used, and says so honestly when the material does not support an answer.
- **Uploads** — PDF, DOCX/DOC, RTF, ODT, Markdown and plain text, with the extraction result
  shown (including warnings and page counts).
- **Study summaries, Visual Study Studio and Learning Path** — cited notes, concept maps,
  flowcharts, tables, timelines and step-by-step paths, all built from the uploaded material.
- **Practice quizzes** — recall drills (definitions) or mixed sets (definitions plus
  recognising statements), generated locally when no model is configured.
- **Wrong-answer diagnostics** — concept-level feedback derived from the stored quiz data.
- **Flashcards, due-review queue and Progress** — every card answer cites its source; the
  review schedule comes from the student's own ratings.
- **Learning DNA and the Adaptive Exam Coach** — an evidence profile of recorded attempts and
  ratings, and a next-practice recommendation with the reason and the counts behind it.
- **Study plan** — a syllabus mapped to the uploaded documents, with a daily schedule the
  student can edit, pause and complete, and which updates from recorded practice.
- **Bangla and English material** — tokenisation, sentence splitting, language detection and
  generated content handle both scripts. Interface copy is English; see
  [What is not implemented](#what-is-not-implemented).

## How answers stay grounded

1. Text is extracted from the upload and split into passages that keep document, page and
   heading metadata.
2. A per-learner BM25 index is built from **that learner's ready documents only**. The learner
   filter is applied when the index is built, so a crafted query cannot reach another
   account's passages.
3. A passage is used only when its IDF-weighted query-term coverage reaches the configured
   threshold. Below it, the teacher refuses instead of answering from a weak match.
4. Citations are verified against the passages that were actually supplied; invented
   citations are stripped before display.

There is **no separate “reasoning model” grading answers**. When a live provider is
configured it writes the wording of an answer or a quiz; correctness for quizzes is decided by
the stored answer key, and diagnostics are deterministic summaries of recorded answers. No
component estimates ability, predicts a grade, or claims mastery or learning gain.

With `LEARNSPHERE_AI_PROVIDER=none` (the default) no text leaves the machine: extraction,
retrieval, citations, summaries, flashcards, paths, quizzes and the coach all run locally.

## Accounts, identity and data isolation

The server has two identity modes, chosen with `AUTH_MODE`:

| Mode | Intended use | Identity |
| --- | --- | --- |
| `local` (default in development) | one student on one machine, demo, judging | a browser-asserted study profile (`X-Learner-Id`) |
| `required` (default in production) | any public or shared deployment | a server-verified account session |

**`local` is not authentication.** The profile id is sanitised and every store query filters
on it, but anyone who can reach the API can send any profile id. The Settings screen and
`/api/health` say this explicitly, and the server logs a warning at startup.

In `required` mode:

- Registration and sign-in live at `/api/auth/*`. Passwords are hashed with **scrypt** and a
  per-user random salt (never stored or logged in plain text; minimum 10 characters).
- The session is a random 32-byte token in an **HttpOnly, SameSite=Lax** cookie. Only a SHA-256
  digest of the token is stored, so a copy of the data directory cannot be replayed as a login.
- Every API route except `/api/health`, `/api/config` and `/api/auth/*` answers **401**
  without a session, and the account id — not any request header — decides whose rows are
  read or written.
- Signing out deletes the session server-side and clears the cookie. Signing in rotates the
  session: the pre-login token stops working immediately.
- State-changing requests must echo the session-bound CSRF token (`ls_csrf` cookie →
  `X-CSRF-Token` header). Requests without it answer 403 `csrf_failed`.
- The frontend is route-driven: `/` is a public welcome page, `/login`, `/signup` and `/reset`
  are real forms, `/onboarding` is shown once to a new account, and any other route redirects a
  signed-out visitor to `/login?next=<path>` so sign-in resumes where they were going.
- `/api/account` exposes the profile, a JSON export of the caller's own data, and deletion.
  Export never contains a password hash; deletion requires the account password, removes every
  owned row and file, and deletes the account record.
- Password reset is a single-use, hashed, 30-minute token. **No email provider is bundled**, so
  on non-production deployments the one-time token is returned to the page (labelled as a
  development token, `AUTH_DEV_RESET=0` disables it); production must configure delivery, and
  nothing is exposed there.

Local-mode data is **not** silently migrated into an account. The two are separate learners by
design; moving a library between them would be a data migration, and this build does not do one.

## Storage and backups

All state lives under `LEARNSPHERE_DATA_DIR` (default `server/data/`, ignored by Git):

- `materials.json`, `sessions.json`, `quizzes.json`, `attempts.json`, `flashcard-decks.json`,
  `flashcard-reviews.json`, `studio-visuals.json`, `learning-paths.json`,
  `study-plans.json`, `users.json`, `auth-sessions.json`, `password-resets.json`
- `raw/` — the uploaded files
- `chunks/` — extracted passages per material

Writes are serialised per file and committed with a temp file + rename, so a crash cannot leave
truncated JSON. A failed mutation or write is discarded and the queue keeps working; there is a
regression test for that (`server/test/storage.queue.test.js`).

`render.yaml` mounts a persistent disk at `/var/data` and sets
`LEARNSPHERE_DATA_DIR=/var/data/learnsphere`; without a persistent disk, uploads are lost when
the service restarts. Back up by copying that directory while the service is stopped (or
copying `*.json` plus `raw/` and `chunks/`). A single instance is supported; multiple instances
would need shared storage and a shared rate-limit store.

## Study plan

The plan (`/plan`, `POST /api/plan`) takes a pasted syllabus, an exam date, optional subjects,
minutes per day, days per week and a preferred language. Each topic is matched against the
learner's indexed passages and reported as:

- **Covered by your material** — a document matched the topic. This does **not** mean the
  student has learned it.
- **Needs practice** — a document matched, and recorded quiz answers (below 80% on at least two
  answers) or flashcard ratings (half or more “Again”/“Hard”) suggest another pass.
- **Not found in uploaded material** — nothing matched. It is listed as a gap and is **never**
  scheduled as study.

The daily schedule mixes short study sessions (linking to the cited document), practice quizzes
(scoped to the matching documents) and, when cards are due, the existing review queue. The plan
never creates, moves or duplicates review dates. Tasks can be marked done, paused or resumed;
edits and refreshes rebuild the schedule but keep completed and paused tasks (task ids are
derived from date + kind + topic). “Why this topic” is written from counts, and there is no
grade prediction anywhere.

## Environment variables

Copy `.env.example` to `.env`. Everything is optional; the app runs with no configuration.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `NODE_ENV` | `development` | `production` also switches the `AUTH_MODE` default |
| `AUTH_MODE` | `required` in production, `local` otherwise | identity mode (table above) |
| `SESSION_TTL_DAYS` | `14` | account session lifetime |
| `AUTH_RESET_TTL_MINUTES` | `30` | password-reset token lifetime |
| `AUTH_DEV_RESET` | on outside production | return the one-time reset token to the page; set `0` to disable |
| `TRUST_PROXY` | `0` | reverse-proxy hops to trust for `req.ip`; only a hop count is accepted |
| `LEARNSPHERE_DATA_DIR` | `server/data` | storage directory |
| `LEARNSPHERE_AI_PROVIDER` | `none` | `none`, `groq`, `gemini`, `openrouter`, `mistral`, `cloudflare`, `custom` |
| `LEARNSPHERE_AI_API_KEY` | empty | server-side only; never sent to the browser |
| `LEARNSPHERE_AI_MODEL` | provider default | model id |
| `AI_TIMEOUT_MS` | `45000` | per-attempt provider timeout; timeouts are not retried |
| `RATE_LIMIT_PER_MINUTE` | `120` | per-profile ceiling; the per-IP ceiling is 4× this |
| `MAX_UPLOAD_MB`, `MAX_DOCUMENTS`, `RETRIEVAL_TOP_K`, `RETRIEVAL_MIN_SCORE` | see `.env.example` | limits and retrieval tuning |

Provider privacy notes (verified October 2026) are in `.env.example` and shown in Settings.

## Development and tests

Requires Node.js >= 20.11.0.

```
npm install
npm run dev        # Express on 8787 + Vite on 5173, ports auto-advance if taken
npm test           # full server suite
npm run test:eval  # grounded-answer evaluation set
npm run build      # production web bundle
```

`npm run dev` leaves existing processes untouched and prints the chosen URLs. Set `PORT` and
`VITE_PORT` to pick starting ports.

Validation notes:

- `npm test` boots the real Express app against a temporary data directory (no mocks) and
  covers retrieval, grounding, uploads, quizzes, flashcards, review queue, DNA, coach, study
  plans, account isolation, rate limiting, secret handling and the Netlify proxy contract.
- `npm run test:eval` runs the offline evaluation set.
- `npm run build` is required before `npm run start` serves the SPA, and before the
  “no key in the bundle” test can inspect `web/dist`.

## Deployment

The SPA and the Express API deploy separately:

1. **Render** — `render.yaml` runs `npm run start --workspace server`, health-checks
   `/api/health`, and mounts the persistent disk described above.
2. **Netlify** — build with `npm run build`, publish `web/dist`, and route `/api/*` through
   `netlify/functions/api.mjs` to the backend. That proxy forwards multiple `Set-Cookie`
   headers, so account sessions work through it. It gives the upstream 9 seconds
   (`LEARNSPHERE_PROXY_TIMEOUT_MS`, capped below Netlify's 10-second synchronous limit) and
   returns a retryable `backend_timeout` after that.

Set `LEARNSPHERE_BACKEND_URL` in Netlify (scope: **Functions**) when the backend is not the
default one. A folder-only static deploy does not include functions; deploy the repository.

**For any public deployment:** set `AUTH_MODE=required`, set `CORS_ALLOWED_ORIGINS` to the
site's exact origin, keep `TRUST_PROXY=0` unless a known proxy is in front, and give the
service a persistent disk. `netlify.toml` deliberately keeps the secrets scanner enabled for
`LEARNSPHERE_AI_API_KEY`.

Long AI generations can exceed the proxy's 9-second budget. The failure is a clear, retryable
`backend_timeout`; retrying is safe because the API writes nothing (quiz, attempt, message)
until a request succeeds. There is no asynchronous job/status flow in this build — see below.

## Privacy

- With no provider key, nothing leaves the machine.
- With a provider, only the retrieved passages for one request are sent. Uploaded files are
  never sent whole, and the rest of the library is never sent.
- The API never logs question text, document content or keys. Request logs contain only method,
  path, status and duration.
- API responses are `Cache-Control: no-store`. Session cookies are HttpOnly and SameSite=Lax.
- Error messages are written for students and never include stack traces, filesystem paths or
  provider response bodies.

## Rotating a leaked API key

If a key may have been exposed (shared, committed, pasted into a chat, included in a bundle):

1. Revoke it in the provider dashboard (Groq, Google AI Studio, OpenRouter, Mistral or
   Cloudflare) and create a new one.
2. Put the new value in `.env` locally and in the host's environment variables (Render →
   Environment; never in a committed file). Redeploy or restart so the process reloads it.
3. Confirm `.env` is ignored by Git (`git check-ignore -v .env`) and purge the old value from
   any branch/history where it appears.
4. Run `npm test` — the secrets test fails if the configured key appears in `web/dist`, and it
   also checks that `.env.example` has blank placeholders.

Rotation is complete only when the old key is revoked at the provider. Nothing in this
repository can revoke it.

## What is not implemented

Stated plainly so nobody plans around a feature that is not there:

- **No OCR.** Scanned/image-only PDFs extract no text; the upload is kept with an explicit
  extraction warning and nothing is indexed, so those pages are reported as uncovered — never
  as covered. External OCR is not called.
- **No offline/PWA mode and no voice input/output.** Private study files are never cached for
  offline use.
- **No asynchronous AI job queue.** Requests are synchronous, bounded by the provider timeout
  and, behind the Netlify proxy, by the 9-second upstream budget.
- **Interface translation is partial.** Welcome, sign-in, sign-up, reset, onboarding, the
  navigation shell, appearance/language controls and the account settings/data sections are
  translated between English and Bangla. Deep tool screens (quiz player, studio, plan editor)
  still use English labels; Bangla and English *material* is handled end to end. Banglish input
  is handled only through normal tokenisation, not a dedicated transliteration layer.
- **No email delivery for password reset.** The flow is implemented and tested (hashed,
  single-use, expiring tokens; all sessions revoked on reset), but no mail provider is bundled.
  Outside production the token is shown on the page for local/demo use; production needs a
  delivery integration before the reset link can leave the server.
- **OCR, voice and offline/PWA are not implemented**, so scanned-only PDFs and voice questions
  are out of scope rather than faked.
- **Rate limiting is in-memory per process**, so it is exact for one instance and indicative
  for more.
- **No spaced-repetition algorithm changes**: the review queue is derived from the learner's own
  ratings and the plan only links to it.
- The shared `local` profile is never treated as an account and is never shown to a signed-in
  account. In account mode the browser profile id is ignored by the server for identity.

## Team and licence

- **Product**: LearnSphere AI
- **Team**: NITER_Parallax
- **Competition**: International AI Builders Congress 2026, Challenge: AI Teacher

© 2026 LearnSphere AI, MIT License.
