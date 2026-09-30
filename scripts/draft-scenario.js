// Turns an employee's (anonymised) story into a DRAFT scenario file for a
// person to review — see scenarios/README.md. Drafts are written to
// scenarios/drafts/, which the server never loads, so nothing generated here
// goes live until someone has read it and moved it into scenarios/.
//
//   npm run draft-scenario -- scenarios/stories/my-story.md

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const { MODEL, withTimeout, isOverloaded } = require("../lib/gemini");
const { SCENARIOS_DIR, loadCharacters, validateScenario } = require("../lib/scenarios");

const DRAFTS_DIR = path.join(SCENARIOS_DIR, "drafts");
const EXAMPLE_SCENARIO = path.join(SCENARIOS_DIR, "phoenix-slipping.json");
const GUIDE = path.join(SCENARIOS_DIR, "README.md");

const STRING = { type: "STRING" };
const INTEGER = { type: "INTEGER" };

// Mirrors the scenario format. Gemini's schema can't express free-form maps,
// so event reactions come back as a list and are converted afterwards.
function buildResponseSchema(characterKeys) {
  return {
    type: "OBJECT",
    properties: {
      id: STRING,
      title: STRING,
      difficulty: INTEGER,
      summary: STRING,
      projectName: STRING,
      phase: STRING,
      briefing: {
        type: "OBJECT",
        properties: {
          llm: STRING,
          display: {
            type: "OBJECT",
            properties: {
              objectives: { type: "ARRAY", items: STRING },
              timeline: {
                type: "ARRAY",
                items: { type: "OBJECT", properties: { when: STRING, what: STRING }, required: ["when", "what"] },
              },
              deadlineNote: STRING,
              risks: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: { level: { type: "STRING", enum: ["high", "medium", "low"] }, text: STRING },
                  required: ["level", "text"],
                },
              },
            },
            required: ["objectives", "timeline", "risks"],
          },
        },
        required: ["llm", "display"],
      },
      rules: {
        type: "OBJECT",
        properties: {
          winThreshold: INTEGER,
          loseThreshold: INTEGER,
          lossGraceMessages: INTEGER,
          deltaClamp: { type: "OBJECT", properties: { min: INTEGER, max: INTEGER } },
        },
      },
      openRisks: { type: "ARRAY", items: STRING },
      stakeholders: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            ref: { type: "STRING", enum: [...characterKeys, "none"] },
            key: STRING,
            fullName: STRING,
            role: STRING,
            pronoun: STRING,
            personality: STRING,
            privateMotivation: STRING,
            styleNotes: STRING,
            situation: STRING,
            opener: STRING,
            winLine: STRING,
            loseLine: STRING,
            insultLine: STRING,
            startConfidence: INTEGER,
            noScoring: { type: "BOOLEAN" },
            card: { type: "OBJECT", properties: { personality: STRING, motivation: STRING, note: STRING } },
          },
          required: ["ref", "opener"],
        },
      },
      events: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: STRING,
            afterTurns: INTEGER,
            text: STRING,
            briefingAddendum: STRING,
            confidenceShift: INTEGER,
            reactions: {
              type: "ARRAY",
              items: { type: "OBJECT", properties: { stakeholder: STRING, line: STRING }, required: ["stakeholder", "line"] },
            },
          },
          required: ["id", "afterTurns", "text", "briefingAddendum"],
        },
      },
      draftNotes: STRING,
    },
    required: ["id", "title", "difficulty", "summary", "projectName", "phase", "briefing", "stakeholders", "draftNotes"],
  };
}

function buildPrompt(story, characters) {
  return `
You are helping build ConsultSim, a training simulation where consultants
practise difficult client conversations with AI-played stakeholders. Turn the
STORY below into one scenario file.

HOW SCENARIOS WORK (authoring guide):
${fs.readFileSync(GUIDE, "utf-8")}

REUSABLE CAST (characters.json). Use "ref" to reuse one of these, and then
include ONLY the fields you are overriding (typically startConfidence,
situation, opener, winLine, loseLine, card.note) — don't restate the base
personality or motivation:
${JSON.stringify(characters, null, 2)}

A COMPLETE EXAMPLE SCENARIO, for tone, length and level of detail:
${fs.readFileSync(EXAMPLE_SCENARIO, "utf-8")}

RULES FOR THE DRAFT:
- Everything must be FICTIONAL. Replace any client, company, product or
  person's name that appears in the story with invented ones, and blur any
  identifying figures. If the story fits a data-platform migration, recast it
  onto Project Phoenix and the cast above; otherwise invent a new projectName
  and define personas inline (ref "none", with every required field).
- Keep what made the real situation hard: the pressure, the hidden concerns,
  what changed mid-way. That is the training value.
- Put what each character privately knows and feels in "situation" (or
  privateMotivation for inline personas), never in the opener or card.
- The difficulty should follow the storyteller's suggestion if given, using
  the levers in the guide. Include at least one scored client stakeholder.
  Include a noScoring colleague check-in (e.g. ref "ben" with a situation
  tied to the story) when the story has a people or wellbeing angle.
- Use events for anything that changed partway through the real story.
- Event reactions must only name stakeholders in this scenario, by key (the
  ref for reused characters).
- id is kebab-case and unique-sounding (e.g. "phoenix-vendor-walkout").
- draftNotes: a short note for the human reviewer — what you invented or
  changed, and anything they should double-check before publishing.

STORY:
${story}
`.trim();
}

// Drops empty strings/arrays/objects the model filled in for optional
// fields, and reshapes the bits the response schema couldn't express.
function tidy(raw) {
  const prune = (value) => {
    if (Array.isArray(value)) {
      const items = value.map(prune).filter((v) => v !== undefined);
      return items.length ? items : undefined;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value)
        .map(([k, v]) => [k, prune(v)])
        .filter(([, v]) => v !== undefined);
      return entries.length ? Object.fromEntries(entries) : undefined;
    }
    if (typeof value === "string" && !value.trim()) return undefined;
    return value;
  };

  const { draftNotes, ...scenario } = prune(raw) || {};

  scenario.stakeholders = (scenario.stakeholders || []).map(({ ref, ...rest }) =>
    ref && ref !== "none" ? { ref, ...rest } : rest
  );
  scenario.events = (scenario.events || []).map(({ reactions, ...rest }) => ({
    ...rest,
    ...(reactions ? { reactions: Object.fromEntries(reactions.map((r) => [r.stakeholder, r.line])) } : {}),
  }));
  if (!scenario.events.length) delete scenario.events;

  return { _draftNotes: draftNotes || "", ...scenario };
}

async function generate(ai, contents, config) {
  const MAX_RETRIES = 10;
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTimeout(ai.models.generateContent({ model: MODEL, contents, config }), 90000);
    } catch (err) {
      if (!isOverloaded(err) || attempt === MAX_RETRIES) throw err;
      console.warn(`Gemini overloaded/slow — retry ${attempt + 1}/${MAX_RETRIES}...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function main() {
  const storyPath = process.argv[2];
  if (!storyPath) {
    console.error("Usage: npm run draft-scenario -- <path/to/story.md>");
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set — add it to .env first.");
    process.exit(1);
  }

  const story = fs.readFileSync(storyPath, "utf-8");
  const characters = loadCharacters();
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  console.log(`Drafting a scenario from ${storyPath} with ${MODEL}…`);
  const result = await generate(ai, [{ role: "user", parts: [{ text: buildPrompt(story, characters) }] }], {
    temperature: 0.7,
    maxOutputTokens: 8192,
    responseMimeType: "application/json",
    responseSchema: buildResponseSchema(Object.keys(characters)),
  });

  const draft = tidy(JSON.parse((result.text || "").trim()));
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const outFile = path.join(DRAFTS_DIR, `${draft.id || `draft-${Date.now()}`}.json`);
  fs.writeFileSync(outFile, JSON.stringify(draft, null, 2) + "\n", "utf-8");

  console.log(`\nDraft written to ${path.relative(process.cwd(), outFile)}`);
  if (draft._draftNotes) console.log(`\nNotes for the reviewer:\n${draft._draftNotes}`);

  const errors = validateScenario(draft, characters);
  if (errors.length) {
    console.log(`\nIt doesn't validate yet — fix these before publishing:\n  - ${errors.join("\n  - ")}`);
  } else {
    console.log("\nIt validates. Review it, delete _draftNotes, then move it into scenarios/ to publish.");
  }
}

main().catch((err) => {
  console.error("Drafting failed:", err && err.message ? err.message : err);
  process.exit(1);
});
