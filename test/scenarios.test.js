const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  SCENARIOS_DIR,
  DEFAULT_RULES,
  loadCharacters,
  loadScenarios,
  validateScenario,
  resolveScenario,
  toClientScenario,
} = require("../lib/scenarios");

const characters = loadCharacters();
const scenarioFiles = fs
  .readdirSync(SCENARIOS_DIR)
  .filter((f) => f.endsWith(".json") && f !== "characters.json");

function minimalScenario(overrides = {}) {
  return {
    id: "test-scenario",
    title: "Test",
    difficulty: 1,
    summary: "A test.",
    projectName: "Project Test",
    phase: "Week 1",
    briefing: { llm: "Briefing.", display: { objectives: ["Do the thing."] } },
    stakeholders: [{ ref: "jenny" }],
    ...overrides,
  };
}

for (const file of scenarioFiles) {
  test(`${file} is a valid scenario`, () => {
    const raw = JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, file), "utf-8"));
    assert.deepEqual(validateScenario(raw, characters), []);
    assert.equal(`${raw.id}.json`, file, "file name should match the scenario id");
  });
}

test("every published scenario loads, with no duplicates", () => {
  const errors = [];
  const scenarios = loadScenarios({ characters, log: { error: (msg) => errors.push(msg) } });
  assert.deepEqual(errors, []);
  assert.equal(scenarios.size, scenarioFiles.length);
});

test("the kickoff scenario keeps the original game's rules and cast", () => {
  const kickoff = loadScenarios({ characters }).get("phoenix-kickoff");
  assert.deepEqual(kickoff.rules, DEFAULT_RULES);
  assert.deepEqual(
    kickoff.stakeholders.map((s) => [s.key, s.startConfidence]),
    [["jenny", 50], ["david", 35], ["priya", 65], ["ben", undefined]]
  );
});

test("scenario overrides replace base persona fields, and card fields merge", () => {
  const scenario = resolveScenario(
    minimalScenario({
      stakeholders: [{ ref: "david", startConfidence: 10, situation: "Angry.", card: { note: "New note." } }],
    }),
    characters
  );
  const david = scenario.cast.david;
  assert.equal(david.startConfidence, 10);
  assert.equal(david.situation, "Angry.");
  assert.equal(david.fullName, characters.david.fullName);
  assert.equal(david.colleague.name, "Satish Patel");
  assert.equal(david.card.note, "New note.");
  assert.equal(david.card.personality, characters.david.card.personality);
});

test("partial rules are filled in from the defaults", () => {
  const scenario = resolveScenario(minimalScenario({ rules: { deltaClamp: { max: 18 } } }), characters);
  assert.deepEqual(scenario.rules.deltaClamp, { min: -15, max: 18 });
  assert.equal(scenario.rules.winThreshold, DEFAULT_RULES.winThreshold);
});

test("inline personas get defaults for initials, avatar and canned replies", () => {
  const scenario = resolveScenario(
    minimalScenario({
      stakeholders: [
        {
          key: "sam",
          fullName: "Sam Rivera",
          role: "COO",
          pronoun: "their",
          personality: "Blunt.",
          privateMotivation: "Wants a promotion.",
          styleNotes: "Push back.",
          opener: "Well?",
          winLine: "Fine.",
          loseLine: "No.",
          insultLine: "Out.",
          startConfidence: 40,
        },
      ],
    }),
    characters
  );
  const sam = scenario.cast.sam;
  assert.equal(sam.initials, "SR");
  assert.equal(sam.avatarClass, "avatar-1");
  assert.ok(sam.replies.length > 0);
});

test("validation catches the common mistakes", () => {
  const cases = [
    [{ difficulty: 7 }, /difficulty/],
    [{ stakeholders: [{ ref: "nobody" }] }, /not in characters\.json/],
    [{ stakeholders: [{ ref: "ben" }] }, /at least one stakeholder must be scored/],
    [{ stakeholders: [{ ref: "jenny" }, { ref: "jenny" }] }, /duplicate stakeholder key/],
    [{ rules: { winThreshold: 30, loseThreshold: 40 } }, /loseThreshold must be below/],
    [{ events: [{ id: "e", afterTurns: 0, text: "x" }] }, /afterTurns/],
    [{ events: [{ id: "e", afterTurns: 2, text: "x", reactions: { priya: "hi" } }] }, /unknown stakeholder "priya"/],
    [{ stakeholders: [{ key: "sam", fullName: "Sam" }] }, /missing role/],
  ];
  for (const [overrides, pattern] of cases) {
    const errors = validateScenario(minimalScenario(overrides), characters);
    assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern} in ${JSON.stringify(errors)}`);
  }
});

test("the client view never exposes hidden persona details", () => {
  const scenario = resolveScenario(
    minimalScenario({
      stakeholders: [{ ref: "david", situation: "Secretly furious." }],
      events: [{ id: "e", afterTurns: 1, text: "News.", briefingAddendum: "Secret context." }],
    }),
    characters
  );
  const json = JSON.stringify(toClientScenario(scenario));
  for (const secret of ["privateMotivation", "styleNotes", "technicalFocus", "colleague", "situation", "Secretly furious", "briefingAddendum", "Secret context", "Briefing."]) {
    assert.ok(!json.includes(secret), `client scenario leaked ${secret}`);
  }
});
