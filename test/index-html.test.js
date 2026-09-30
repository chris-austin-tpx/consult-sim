const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Stakeholder cards and switcher buttons are rendered by script.js from the
// selected scenario, so index.html must not carry hardcoded copies of them
// (a merge once reintroduced them, showing every stakeholder twice).
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("index.html has no hardcoded stakeholder cards", () => {
  assert.equal((html.match(/class="stakeholder-grid"/g) || []).length, 1);
  assert.doesNotMatch(html, /class="stakeholder-card/);
});

test("index.html has a single, empty stakeholder switcher", () => {
  assert.equal((html.match(/class="stakeholder-switcher"/g) || []).length, 1);
  assert.doesNotMatch(html, /data-stakeholder=/);
});
