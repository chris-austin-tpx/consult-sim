# ConsultSim

An AI-powered client engagement simulator, originally built as a hackathon prototype. The player takes on the role of a consultant leading a fictional client engagement, and has to navigate technical questions, difficult stakeholders, and the everyday pressures of a real consulting project — through free-text conversation with AI-driven characters.

## What it does

You're the lead consultant on **Project Phoenix** — a fictional client migrating a legacy on-premise data warehouse to Azure Databricks. You'll hold conversations with three stakeholders, each with their own personality, motivations, and concerns:

- **Jenny Mensah** — Chief Financial Officer, direct and numbers-driven, focused on the month-end close timeline
- **David Kowalski** — Head of IT Infrastructure, protective of his team and skeptical of outside consultants. He brings his senior cloud engineer, **Satish Patel**, into the conversation to ask technical questions about the target platform (data storage, multi-tenancy, security) — give a wrong answer and Satish will call it out
- **Priya Anand** — Finance Operations Manager, pragmatic and capacity-constrained around month-end close

Each conversation tracks a **confidence score** that rises or falls based on the quality of your answers (judged by the AI in-character, not by superficial things like message length). Reach 80% and you've won that stakeholder over; drop below 30%, or say something genuinely outrageous, and you lose them — and losing any one stakeholder ends the whole round.

### Scenarios and difficulty

You choose a **scenario** from the level list before you start. Each one is a JSON file in [`scenarios/`](scenarios/README.md):

- ★ **Kickoff**: the original week-2 game.
- ★★ **Slipping Behind**: four weeks late, and the client found out second-hand.
- ★★★ **Moving Goalposts**: the go-live date is pulled forward partway through your conversations.
- ★★★★ **Escalation**: a data incident reached the board, and IT has gone over your head.

Scenarios get harder through lower starting confidence, hostile situations, **mid-round events**, and tighter rules (win threshold, how much one answer can gain, grace period). New scenarios can be hand-written, or drafted from an employee's anonymised story with `npm run draft-scenario` and then reviewed. See [scenarios/README.md](scenarios/README.md).

Once the round ends (win or lose), you get an **AI-generated performance review** assessing how you communicated, took ownership, and handled pressure and ambiguity — mapped to a five-level progression ladder (Junior/Graduate through Principal) and including specific feedback on what to focus on to reach the next level.

## Why it's built this way

This project deliberately mixes scripted and AI-generated content:

- The **scenarios, stakeholder personalities, and objectives** are curated, fictional data files reviewed by a person — this keeps the simulation focused and repeatable, and means nothing about a real client or company ever needs to be involved.
- **Stakeholder replies are generated live by Google's Gemini API**, in-character, with full memory of the conversation so far. This is what makes the "conversation" actually feel like one — stakeholders remember commitments, react to specifics, and push back on vague answers.
- If Gemini is unavailable (rate limits, an outage, no API key configured), the app **falls back to a small set of scripted replies** per stakeholder, so a demo never fully breaks — it just gets less dynamic.
- The **performance review rubric** is an original, condensed write-up of general consulting-competency levels (communication, ownership, handling complexity, supporting others, learning & adaptability) — see [Performance review rubric](#performance-review-rubric) below for why it's written the way it is.

## Architecture

It's intentionally simple: a static frontend and a thin backend that talks to Gemini.

```
index.html   — screens: welcome, briefing, stakeholders, live simulation, performance review
styles.css   — all styling
script.js    — all frontend logic: level select, screen navigation, rendering the chosen scenario,
               conversation state, confidence/win-loss tracking, scenario events, calling the backend
server.js    — Express server: serves the static frontend, lists scenarios, proxies conversation
               turns and reviews to Gemini, builds the character prompts, holds the scoring rubric
lib/         — scenario loading/validation/merging (scenarios.js) and shared Gemini helpers
scenarios/   — one JSON file per level, plus the reusable cast in characters.json
scripts/     — draft-scenario.js: turns an anonymised story into a draft scenario
test/        — node:test checks that every scenario is valid and hidden details stay server-side
```

There's no database and no user accounts. A round's state lives in the browser tab, so refreshing mid-round resets it. Completed attempts are saved to a local, gitignored `.data/history.json`, which feeds the My Progress screen and each level's best result.

### How a conversation turn works

1. The player sends a message. It's checked locally for outright abuse (a small regex list) — if it matches, the conversation ends immediately as a loss, without calling the API at all.
2. Otherwise, the frontend calls `POST /api/chat` with the message, that stakeholder's conversation history, and the current confidence score.
3. The backend builds a system prompt for that character (personality, private motivation, and — for David — his colleague Satish's briefing and the specific technical questions to raise) and asks Gemini for a structured JSON response: one or more dialogue segments (to support a second speaker chiming in) plus a `confidenceDelta` reflecting how convincing the answer was.
4. The response streams back over Server-Sent Events, so if Gemini is under load and needs retries, the player sees live progress ("David is thinking… retry 4/30") instead of a silent wait.
5. If every retry fails, the frontend falls back to a scripted reply for that stakeholder and a simple length-based heuristic for the confidence change.

### Performance review rubric

The performance review is deliberately **not** based on any specific company's actual internal progression framework or job-leveling documents, even though the idea for it came from one. The rubric baked into `server.js` (`PERFORMANCE_RUBRIC`) is an original, condensed write-up covering five generic, broadly-applicable consulting dimensions:

1. Clarity & trust in communication
2. Ownership & follow-through
3. Handling complexity, ambiguity & pushback
4. Supportive, collaborative mindset
5. Learning & adaptability

If you want to base this on your own organization's actual progression framework, treat `PERFORMANCE_RUBRIC` and `PERFORMANCE_LEVELS` in `server.js` as the place to do it — but be deliberate about what you send to a third-party AI API, since that rubric's content is sent to Gemini as part of every performance review request.

## Getting started

### Requirements

- [Node.js](https://nodejs.org/) 18 or later (LTS recommended)
- A [Gemini API key](https://ai.google.dev/) — the free tier is enough to run this

### Setup

```bash
git clone <this-repo-url>
cd consultsim
npm install
cp .env.example .env
```

Edit `.env` and add your key:

```
GEMINI_API_KEY=your_actual_key_here
PORT=3000
```

### Run it

```bash
npm start
```

Then open **http://localhost:3000** in your browser. (Opening `index.html` directly as a local file won't work — the app needs the backend running to talk to Gemini.)

### No API key?

The app still runs — every stakeholder falls back to a small set of scripted replies, and the performance review will show as unavailable. Useful for checking the UI without burning API quota, but the actual "conversation" experience needs a real key.

## Known limitations / things to know before extending this

- **Gemini model availability changes.** The model name is hardcoded in `server.js` (`MODEL` constant). Google periodically retires older models in favour of newer ones — if you start seeing 404 errors, check what's currently available on your API key and update the constant.
- **Free-tier rate limits are real.** You may see stakeholders "thinking" for a long time (up to ~30 retries with backoff) during periods of high demand on Google's side — this is expected and by design, not a bug, though it can make a live demo feel slow at the worst possible moment.
- **The confidence-scoring heuristic for the *fallback* path (when Gemini is unavailable) is crude** — it's based on message length, not content, since there's no AI available to judge it. This only kicks in when Gemini itself has failed, so it's a safety net, not the primary scoring mechanism.
- **Tests cover scenario data only.** `npm test` validates every scenario file and the persona merging. Gameplay has been verified manually in the browser.

## Project structure

```
.
├── index.html          # All screens/markup
├── styles.css           # All styling
├── script.js            # Frontend logic
├── server.js             # Backend: Gemini proxy, character prompts, scoring, feedback rubric
├── package.json
├── .env.example          # Template for your local .env (never commit the real one)
└── reference_files/      # (gitignored) local-only reference material, not part of the app
```
