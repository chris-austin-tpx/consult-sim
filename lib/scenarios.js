// Scenario loading, validation and persona merging — shared by server.js,
// the draft-scenario script and the tests, so there's exactly one definition
// of what a valid scenario looks like.
//
// A scenario file (scenarios/<id>.json) describes one playable level: the
// briefing, the rules that set its difficulty, the cast, and any mid-round
// events. Cast members either reference a reusable base persona from
// scenarios/characters.json (`ref`) and override fields on it, or define a
// full persona inline (for scenarios set somewhere other than Project Phoenix).

const fs = require("fs");
const path = require("path");

const SCENARIOS_DIR = path.join(__dirname, "..", "scenarios");
const CHARACTERS_FILE = path.join(SCENARIOS_DIR, "characters.json");

// Defaults match the original single-scenario game, so a scenario that
// leaves `rules` out plays exactly like Project Phoenix always has.
const DEFAULT_RULES = {
  winThreshold: 80,
  loseThreshold: 30,
  lossGraceMessages: 2,
  deltaClamp: { min: -15, max: 25 },
};

const AVATAR_CLASSES = ["avatar-1", "avatar-2", "avatar-3", "avatar-4"];

// Fields a persona must have once any `ref` has been merged in. Scored
// stakeholders additionally need the scoring-only fields below.
const REQUIRED_PERSONA_FIELDS = ["fullName", "role", "pronoun", "personality", "privateMotivation", "styleNotes", "opener"];
const REQUIRED_SCORED_FIELDS = ["winLine", "loseLine", "insultLine", "startConfidence"];

// Everything the browser needs, and nothing it doesn't — private motivations,
// style notes, technical lines of questioning and colleague briefings stay
// server-side so players can't read the hidden agendas in devtools.
const CLIENT_PERSONA_FIELDS = [
  "key", "initials", "role", "avatarClass", "opener", "replies",
  "insultLine", "winLine", "loseLine", "startConfidence", "noScoring", "card",
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function loadCharacters(file = CHARACTERS_FILE) {
  return readJson(file);
}

function initialsOf(fullName) {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase())
    .slice(0, 2)
    .join("");
}

// Merges one cast entry over its base persona. Top-level fields are
// replaced; `card` is merged field-by-field so a scenario can add a note
// without restating the base personality text.
function resolvePersona(entry, characters, index) {
  const base = entry.ref ? characters[entry.ref] : {};
  const { ref, ...overrides } = entry;
  const persona = {
    ...base,
    ...overrides,
    card: { ...(base && base.card), ...overrides.card },
  };
  persona.key = entry.key || ref;
  if (persona.fullName && !persona.initials) persona.initials = initialsOf(persona.fullName);
  if (!persona.avatarClass) persona.avatarClass = AVATAR_CLASSES[index % AVATAR_CLASSES.length];
  if (!Array.isArray(persona.replies) || !persona.replies.length) {
    persona.replies = ["Go on.", "Okay — I'm listening.", "Right. What else?", "Noted."];
  }
  return persona;
}

// Returns a list of human-readable problems with a raw scenario file (empty
// when it's valid). Checks structure only — whether the writing is any good
// is a job for the person reviewing it.
function validateScenario(raw, characters) {
  const errors = [];
  const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

  if (!raw || typeof raw !== "object") return ["scenario must be a JSON object"];

  if (!isNonEmptyString(raw.id) || !/^[a-z0-9-]+$/.test(raw.id)) {
    errors.push("id must be a non-empty kebab-case string");
  }
  for (const field of ["title", "summary", "projectName", "phase"]) {
    if (!isNonEmptyString(raw[field])) errors.push(`${field} is required`);
  }
  if (!Number.isInteger(raw.difficulty) || raw.difficulty < 1 || raw.difficulty > 5) {
    errors.push("difficulty must be an integer from 1 to 5");
  }

  const briefing = raw.briefing || {};
  if (!isNonEmptyString(briefing.llm)) errors.push("briefing.llm is required");
  const display = briefing.display || {};
  if (!Array.isArray(display.objectives) || !display.objectives.length) {
    errors.push("briefing.display.objectives must be a non-empty array");
  }
  if (display.timeline != null && !Array.isArray(display.timeline)) {
    errors.push("briefing.display.timeline must be an array");
  }
  (display.risks || []).forEach((risk, i) => {
    if (!risk || !["high", "medium", "low"].includes(risk.level) || !isNonEmptyString(risk.text)) {
      errors.push(`briefing.display.risks[${i}] needs level (high|medium|low) and text`);
    }
  });

  if (raw.rules != null) {
    const r = raw.rules;
    for (const field of ["winThreshold", "loseThreshold", "lossGraceMessages"]) {
      if (r[field] != null && (!Number.isInteger(r[field]) || r[field] < 0 || r[field] > 100)) {
        errors.push(`rules.${field} must be an integer from 0 to 100`);
      }
    }
    const win = r.winThreshold != null ? r.winThreshold : DEFAULT_RULES.winThreshold;
    const lose = r.loseThreshold != null ? r.loseThreshold : DEFAULT_RULES.loseThreshold;
    if (lose >= win) errors.push("rules.loseThreshold must be below rules.winThreshold");
    if (r.deltaClamp != null) {
      const { min, max } = r.deltaClamp;
      if (!Number.isInteger(min) || !Number.isInteger(max) || min >= 0 || max <= 0) {
        errors.push("rules.deltaClamp needs an integer min < 0 and max > 0");
      }
    }
  }

  const cast = Array.isArray(raw.stakeholders) ? raw.stakeholders : [];
  if (!cast.length) errors.push("stakeholders must be a non-empty array");
  const seenKeys = new Set();
  let scoredCount = 0;
  cast.forEach((entry, i) => {
    const where = `stakeholders[${i}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${where} must be an object`);
      return;
    }
    if (entry.ref && !characters[entry.ref]) {
      errors.push(`${where}.ref "${entry.ref}" is not in characters.json`);
      return;
    }
    if (!entry.ref && !isNonEmptyString(entry.key)) {
      errors.push(`${where} needs either a ref or a key`);
      return;
    }
    const persona = resolvePersona(entry, characters, i);
    if (seenKeys.has(persona.key)) errors.push(`${where}: duplicate stakeholder key "${persona.key}"`);
    seenKeys.add(persona.key);

    const required = persona.noScoring ? REQUIRED_PERSONA_FIELDS : REQUIRED_PERSONA_FIELDS.concat(REQUIRED_SCORED_FIELDS);
    for (const field of required) {
      if (persona[field] == null || persona[field] === "") errors.push(`${where} (${persona.key}) is missing ${field}`);
    }
    if (!persona.noScoring) {
      scoredCount++;
      if (!Number.isInteger(persona.startConfidence) || persona.startConfidence < 0 || persona.startConfidence > 100) {
        errors.push(`${where} (${persona.key}) startConfidence must be an integer from 0 to 100`);
      }
    }
  });
  if (cast.length && !scoredCount) errors.push("at least one stakeholder must be scored (not noScoring)");

  const eventIds = new Set();
  (raw.events || []).forEach((event, i) => {
    const where = `events[${i}]`;
    if (!event || !isNonEmptyString(event.id)) errors.push(`${where}.id is required`);
    else if (eventIds.has(event.id)) errors.push(`${where}: duplicate event id "${event.id}"`);
    else eventIds.add(event.id);
    if (!event || !Number.isInteger(event.afterTurns) || event.afterTurns < 1) {
      errors.push(`${where}.afterTurns must be a positive integer`);
    }
    if (!event || !isNonEmptyString(event.text)) errors.push(`${where}.text is required`);
    if (event && event.confidenceShift != null && !Number.isInteger(event.confidenceShift)) {
      errors.push(`${where}.confidenceShift must be an integer`);
    }
    Object.keys((event && event.reactions) || {}).forEach((key) => {
      if (!seenKeys.has(key)) errors.push(`${where}.reactions references unknown stakeholder "${key}"`);
    });
  });

  return errors;
}

// Turns a validated raw scenario into the shape the server works with:
// rules filled in with defaults, and the cast resolved into full personas.
function resolveScenario(raw, characters) {
  const rules = {
    ...DEFAULT_RULES,
    ...raw.rules,
    deltaClamp: { ...DEFAULT_RULES.deltaClamp, ...(raw.rules && raw.rules.deltaClamp) },
  };
  const stakeholders = raw.stakeholders.map((entry, i) => resolvePersona(entry, characters, i));
  return {
    ...raw,
    rules,
    openRisks: raw.openRisks || [],
    events: raw.events || [],
    stakeholders,
    cast: Object.fromEntries(stakeholders.map((p) => [p.key, p])),
  };
}

// Loads every scenarios/*.json file except characters.json. A broken file
// is logged and skipped rather than taking the whole server down — one bad
// submission shouldn't stop everyone else from playing.
function loadScenarios({ dir = SCENARIOS_DIR, characters = loadCharacters(), log = console } = {}) {
  const scenarios = new Map();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== path.basename(CHARACTERS_FILE))
    .sort();

  for (const file of files) {
    let raw;
    try {
      raw = readJson(path.join(dir, file));
    } catch (err) {
      log.error(`[scenarios] ${file}: not valid JSON — skipped (${err.message})`);
      continue;
    }
    const errors = validateScenario(raw, characters);
    if (errors.length) {
      log.error(`[scenarios] ${file}: skipped —\n  - ${errors.join("\n  - ")}`);
      continue;
    }
    if (scenarios.has(raw.id)) {
      log.error(`[scenarios] ${file}: duplicate id "${raw.id}" — skipped`);
      continue;
    }
    scenarios.set(raw.id, resolveScenario(raw, characters));
  }
  return scenarios;
}

function toClientScenario(scenario) {
  return {
    id: scenario.id,
    title: scenario.title,
    difficulty: scenario.difficulty,
    summary: scenario.summary,
    projectName: scenario.projectName,
    phase: scenario.phase,
    briefing: { display: scenario.briefing.display },
    openRisks: scenario.openRisks,
    rules: scenario.rules,
    // briefingAddendum is for the characters, not the player — the player
    // learns about an event through its `text` and the reactions.
    events: scenario.events.map(({ id, afterTurns, text, confidenceShift, reactions }) => ({
      id, afterTurns, text, confidenceShift: confidenceShift || 0, reactions: reactions || {},
    })),
    stakeholders: scenario.stakeholders.map((p) => {
      const out = { name: p.fullName };
      for (const field of CLIENT_PERSONA_FIELDS) if (p[field] !== undefined) out[field] = p[field];
      return out;
    }),
  };
}

module.exports = {
  SCENARIOS_DIR,
  DEFAULT_RULES,
  loadCharacters,
  loadScenarios,
  validateScenario,
  resolveScenario,
  resolvePersona,
  toClientScenario,
};
