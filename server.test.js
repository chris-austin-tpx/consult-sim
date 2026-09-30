// Integration tests for server.js, using supertest against the exported
// Express app (see nodejs-expert skill's testing patterns).
//
// These deliberately stay deterministic and never call the real Gemini API:
// GEMINI_API_KEY is forced empty before the app is required, which exercises
// the "ai not configured" fallback paths that already exist in every route
// for exactly this situation (rate limits, outages, no key set). Behaviour
// that actually depends on a live model response isn't covered here — that's
// what manual/live testing during development is for.

const os = require("os");
const path = require("path");
const fs = require("fs");

// Point the app at an isolated, throwaway history file so tests never read
// or write the real local .data/history.json, and force "Gemini not
// configured" so every test is fast and fully deterministic.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "consultsim-test-"));
process.env.CONSULTSIM_DATA_DIR = TEST_DATA_DIR;
process.env.GEMINI_API_KEY = "";

const request = require("supertest");
const app = require("./server");

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("GET /api/health", () => {
  it("reports ok and that Gemini is not configured", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, geminiConfigured: false });
    expect(typeof res.body.model).toBe("string");
  });
});

describe("static file protection", () => {
  it("never serves .env", async () => {
    const res = await request(app).get("/.env");
    expect(res.status).toBe(404);
  });

  it("never serves the local attempt history file directly", async () => {
    // Regression test for a real bug: express.static's dotfile protection
    // only checks the FINAL path segment, so /.data/history.json was being
    // served in full despite /.env correctly 404ing. A file must actually
    // exist at the real (non-test-override) .data path for this to be a
    // meaningful check — otherwise it would 404 simply for not existing,
    // whether or not the guard middleware is doing its job.
    const realDataDir = path.join(__dirname, ".data");
    const probeFile = path.join(realDataDir, "history.json");
    fs.mkdirSync(realDataDir, { recursive: true });
    fs.writeFileSync(probeFile, JSON.stringify([{ probe: true }]));

    try {
      const res = await request(app).get("/.data/history.json");
      expect(res.status).toBe(404);
    } finally {
      fs.rmSync(realDataDir, { recursive: true, force: true });
    }
  });
});

describe("POST /api/chat", () => {
  it("rejects an unknown stakeholder", async () => {
    const res = await request(app).post("/api/chat").send({ stakeholder: "nobody", message: "hello" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("rejects a missing message", async () => {
    const res = await request(app).post("/api/chat").send({ stakeholder: "jenny" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("falls back gracefully when Gemini isn't configured", async () => {
    const res = await request(app).post("/api/chat").send({ stakeholder: "jenny", message: "hello" });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, fallback: true });
  });
});

describe("POST /api/feedback", () => {
  it("requires a sessionSummary", async () => {
    const res = await request(app).post("/api/feedback").send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("falls back gracefully when Gemini isn't configured", async () => {
    const res = await request(app).post("/api/feedback").send({ sessionSummary: "some transcript" });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });
});

describe("POST /api/conversation-review", () => {
  it("rejects an unknown stakeholder", async () => {
    const res = await request(app)
      .post("/api/conversation-review")
      .send({ stakeholder: "nobody", transcriptSummary: "..." });
    expect(res.status).toBe(400);
  });

  it("requires a transcriptSummary", async () => {
    const res = await request(app).post("/api/conversation-review").send({ stakeholder: "jenny" });
    expect(res.status).toBe(400);
  });

  it("falls back gracefully when Gemini isn't configured", async () => {
    const res = await request(app)
      .post("/api/conversation-review")
      .send({ stakeholder: "jenny", transcriptSummary: "..." });
    expect(res.status).toBe(503);
  });
});

describe("GET/POST /api/attempts", () => {
  it("starts empty", async () => {
    const res = await request(app).get("/api/attempts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, attempts: [] });
  });

  it("saves an attempt and returns it back via GET", async () => {
    const postRes = await request(app)
      .post("/api/attempts")
      .send({
        level: "Senior",
        summary: "Did well.",
        strengths: ["Clear communication"],
        growthAreas: ["More proactive risk flagging"],
        nextLevelFocus: "Anticipate risks earlier.",
        psychologicalSafetyNotes: "Supported Ben well.",
        stakeholders: [{ key: "jenny", name: "Jenny Mensah", status: "won", confidence: 85 }],
      });

    expect(postRes.status).toBe(200);
    expect(postRes.body.ok).toBe(true);
    expect(postRes.body.attempt.id).toEqual(expect.any(String));
    expect(postRes.body.attempt.timestamp).toEqual(expect.any(String));
    expect(postRes.body.attempt.level).toBe("Senior");

    const getRes = await request(app).get("/api/attempts");
    expect(getRes.body.attempts).toHaveLength(1);
    expect(getRes.body.attempts[0].level).toBe("Senior");
  });

  it("defaults sensibly when given a malformed/empty attempt", async () => {
    const res = await request(app).post("/api/attempts").send({});
    expect(res.status).toBe(200);
    expect(res.body.attempt).toMatchObject({
      level: null,
      summary: "",
      strengths: [],
      growthAreas: [],
      nextLevelFocus: "",
      psychologicalSafetyNotes: "",
      stakeholders: [],
    });
  });
});
