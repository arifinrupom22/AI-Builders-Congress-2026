# LearnSphere AI

LearnSphere AI is a learning platform built to ground student learning in their own study materials. It is a generative AI teacher that:

- teaches from the content you upload,
- applies explanations to your own documents,
- helps you practice with generated questions,
- lets you assess and revise on your own terms.

LearnSphere AI is an education platform built for students, learners, and independent learners who want to deepen their mastery using their own uploaded notes, documents, and practice questions. It is designed to be a source of guidance, explanations, practice questions, and revision that are always grounded in your own uploaded materials.

## Table of Contents

- [Product vision](#product-vision)
- [Product identity](#product-identity)
- [AI principles](#ai-principles)
- [Product modules](#modules)
- [AI architecture](#ai-architecture)
- [Models and prompts](#models-and-prompts)
- [Retrieval and grounding](#retrieval-and-grounding)
- [Quiz generation and assessment](#quiz-generation-and-assessment)
- [Learning progress](#learning-progress)
- [Environment setup](#environment-setup)
- [Development](#development)
- [Testing](#testing)
- [Deployment](#deployment)
- [Privacy and security](#privacy-and-security)
- [Limitations and risks](#limitations-and-risks)
- [Team](#team)
- [Contributing](#contributing)
- [License](#license)

## Product vision

LearnSphere AI is a learning assistant that teaches from your own uploaded materials. It is a generative AI teacher that:

- teaches from the content you upload,
- applies explanations to your own documents,
- helps you practice with generated questions,
- lets you assess and revise on your own terms.

LearnSphere AI is an education platform built for students, learners, and independent learners who want to deepen their mastery using their own uploaded notes, documents, and practice questions.

## Product identity

LearnSphere AI is an education technology product designed to ground student learning in their own study materials. It is an AI Teacher for university students, college students, and independent learners.

### Initial focus

- University-level study materials
- PDF and text notes
- Topic explanations
- Practice MCQs
- Source-grounded question answering

### Product principle

The central product principle is: *Learn from your own materials. Understand the explanation. Verify the source. Practice until you improve.*

## AI principles

LearnSphere AI is a teaching tool designed to help students learn more effectively. It is not a substitute for a human teacher, and it is not a substitute for a human explanation. The product is designed to be useful as a supplement to a human teacher, and to never replace the human teacher.

## Training

LearnSphere AI is a student of your uploaded documents. Its teaching follows a few principles:

- Only the content you have uploaded is taught; nothing is invented.
- Explanations are grounded in your own documents.
- Answers are generated from the text that you have uploaded.
- The system never executes uploaded content.

## Models and prompts

LearnSphere AI uses a combination of:

- A generative model for generating explanations and answers.
- A retrieval model for retrieving relevant passages.
- A quiz model for generating practice questions.
- A reasoning model for evaluating answers.

## Retrieval and grounding

LearnSphere AI grounds every answer in the text that was uploaded. Every answer includes a source reference that points back to the original document, the page number, and the passage identifier.

The retrieval pipeline:

1. Extract text from the uploaded document.
2. Split the text into passages.
3. Build an index.
4. Retrieve the most relevant passages.
5. Return source metadata along with the retrieved passages.

## Quiz generation

LearnSphere AI generates practice quizzes from the files you upload. Each quiz is grounded in your own documents.

The quiz generation is a generative model that generates questions and answers from the content you have uploaded. It is a generative model that generates questions from your own materials.

## Learning progress

LearnSphere AI provides a learning progress view that shows the student how much they have practiced, how many questions they have answered, and how many they have answered correctly. It is a learning progress view, not a performance metric. It is designed to encourage students to practice, not to measure their performance.

## Environment setup

LearnSphere AI runs on your own files. With no AI key configured it sends nothing anywhere: extraction, BM25 retrieval, citations and quiz generation all happen on this machine. If you do configure a provider, only the few passages retrieved for a single question are sent to it - never a whole document, and never the rest of your library.

### Dependencies

- Node.js >= 20.11.0 (the range declared in `engines`)
- npm >= 9

### Installation

Clone the repository and install dependencies:

```
git clone
npm install
```

### Environment setup

Copy `.env.example` to `.env` and set only what you need. The app runs with no configuration at all:

```
# Optional: upgrade answers from the local extractive teacher to a live model.
LEARNSPHERE_AI_PROVIDER=none        # none | groq | gemini | openrouter | mistral | cloudflare | custom
LEARNSPHERE_AI_API_KEY=             # server-side only; never sent to the browser
LEARNSPHERE_AI_MODEL=               # blank uses the provider's default
```

`.env.example` documents every supported variable, including each provider's privacy policy.

## Development

To run LearnSphere AI in development mode:

```
npm run dev
```

This starts the backend server and the web frontend. If the default ports are
already in use, the launcher selects the next available ports and configures
the Vite API proxy to match. It leaves existing processes untouched. The
selected URLs are printed at startup. You can set `PORT` and `VITE_PORT` to
choose the first ports to try.

### Tests

To run the tests:

```
npm run test
```

There is no coverage script in this repository. `npm test` runs the whole Node test suite, and `npm run test:eval` runs the grounded-answer evaluation set.

## Deployment

The frontend and Express API are separate in production. A folder-only static
deploy contains the frontend files, but it does not run the Express process;
that is why API calls such as `/api/config` returned Netlify's 404 page.

### Netlify frontend and API routing

The repository includes `netlify.toml` and a small API proxy function. Deploy
the repository using Netlify's Git integration or Netlify CLI so the function
is built and deployed along with `web/dist`. Dragging only `web/dist` into the
Netlify UI does not deploy functions. See Netlify's [Express/functions deployment guide](https://docs.netlify.com/build/frameworks/framework-setup-guides/express/).

Deploy the backend using the included `render.yaml` Blueprint. It runs the
existing Express server and mounts a persistent disk at `/var/data` for
materials, sessions, quizzes, and uploaded files. Copy your Netlify site URL and
set `CORS_ALLOWED_ORIGINS` on Render to that exact origin (for example,
`https://your-site.netlify.app`). That grant only matters if a browser calls the
API directly; the same-origin proxy below does not need it.

The Netlify Function ships with this project's own deployed API as its default
backend, so a deployment of this repository works with **no environment
variables at all**. To point the site at a different API - a fork, a staging
service, or a host you moved to - set one variable in Netlify under
**Project configuration → Environment variables**:

```
LEARNSPHERE_BACKEND_URL=https://your-backend.onrender.com   # scope: Functions
```

The scope must include **Functions**, and the site has to be deployed again:
Netlify binds a function's environment variables at deploy time, so changing the
value alone leaves the running function on the old one. Setting
`VITE_API_BASE_URL` is optional - leave it unset so the browser calls `/api` on
its own origin and the function forwards it. A relative base URL needs no CORS
grant and cannot break when the backend host changes.

`netlify.toml` also excludes the two builder settings `NODE_ENV` and `PORT` from
Netlify's build secrets scanner (`SECRETS_SCAN_OMIT_KEYS`). Neither is a
credential; both words occur in the published bundle, which is why the scanner
flagged them. Real secrets are still scanned and would still fail the build.

The Render disk requires a paid web-service plan; without persistent storage,
uploaded study materials would be lost when the backend restarts, and the free
plan also sleeps when idle, so the first request of the day can take up to a
minute (the app retries instead of showing an error). See Render's [persistent disk documentation](https://render.com/docs/disks).

For local preview, run `npm run dev`. For a standalone production server, run
`npm run build` followed by `npm run start`.

## Privacy and security

By default - with no AI key - LearnSphere AI sends nothing anywhere, because every step runs locally against your own files. If you configure a provider, only the passages retrieved for one question leave this machine. Each provider's data policy is listed in `.env.example` and shown in the app's Settings screen, so you can decide before uploading anything private.

### Security

- The system does not execute uploaded content.
- The system does not trust instructions embedded in uploaded documents.
- The system preserves document identifiers and source metadata.

## Limitations and risks

- The AI may not answer every question.
- The AI may answer questions that are not supported by the material.
- The AI may generate questions that are not supported by the material.
- The AI may not answer all questions.

## Team

- **Product name**: LearnSphere AI
- **Team**: NITER_Parallax
- **Competition**: International AI Builders Congress 2026

## Contributing

We welcome contributions. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

© 2026 LearnSphere AI. This project is licensed under the MIT License.
