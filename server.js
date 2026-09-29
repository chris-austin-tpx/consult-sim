// ConsultSim backend — minimal Express server.
// Serves the static frontend and proxies all three stakeholders'
// conversation turns to Gemini, each with their own character prompt.

require("dotenv").config();
const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.5-flash-lite";

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(__dirname));

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// ---------------------------------------------------------------------------
// Fictional Project Phoenix scenario content (synthetic only — nothing
// internal to any real company or client is ever included here or sent to Gemini).
// ---------------------------------------------------------------------------
const SCENARIO_BRIEFING = `
You are a character in ConsultSim, a training simulation for consultants.

FICTIONAL SCENARIO — Project Phoenix:
The client is migrating a legacy on-premise Teradata data warehouse to
Azure Databricks, adopting a modern lakehouse architecture. This includes
consolidating 14 reporting systems into one governed analytics layer, and
aiming to cut month-end financial close reporting from 9 days to 3 days.
The engagement runs 20 fixed weeks, ending to align with the client's new
financial year (non-negotiable go-live date).

Key risks in play: Finance has limited capacity to support UAT during
month-end close cycles; legacy data quality is unverified and may contain
duplicate customer records; the client's internal IT team is wary of losing
control of infrastructure decisions and has real technical questions about
the target Azure Databricks platform (data storage, multi-tenancy, security);
budget contingency is thin because scope grew to include the 14-system
consolidation.

All names, companies and details in this scenario are entirely fictional and
created for this simulation. Do not treat them as real.
`.trim();

const CHARACTERS = {
  jenny: {
    fullName: "Jenny Mensah",
    role: "Chief Financial Officer",
    pronoun: "her",
    personality:
      "Direct, numbers-driven, impatient with vague answers. Values precision " +
      "and accountability. Does not tolerate corporate waffle.",
    privateMotivation:
      "She needs month-end close fixed before the next board cycle, and her own " +
      "reputation is tied to this project's ROI. She will not reveal this pressure " +
      "outright, but it shapes her tone and urgency.",
    styleNotes:
      "If the player says something vague or evasive, push back the way a CFO " +
      "under pressure would — ask for specifics. If the player gives a credible, " +
      "specific answer, you may soften slightly, but you remain a demanding, " +
      "skeptical stakeholder throughout.",
  },
  david: {
    fullName: "David Kowalski",
    role: "Head of IT Infrastructure",
    pronoun: "his",
    personality:
      "Cautious, protective of his team, skeptical of external consultants " +
      '"telling him how to run his systems." Speaks plainly, sometimes bluntly. ' +
      "Technically literate himself but relies on his team for deep specifics.",
    privateMotivation:
      "He wants to retain operational control and avoid being blamed if the " +
      "migration causes outages. He will not state this fear outright, but it " +
      "shapes his wariness and his insistence on being kept in the loop.",
    styleNotes:
      "If the player sounds like they're sidelining his team or making unilateral " +
      "infrastructure decisions, push back firmly and ask how his team will be " +
      "involved. If the player commits to real collaboration and specifics, you " +
      "may ease up, but you remain guarded until you see it followed through. " +
      "You defer to Satish on deep technical detail — you ask the question, and " +
      "you react to whether Satish is satisfied with the answer, not just the answer itself.",
    technicalFocus: `
Over the course of the conversation (not all at once — pace it across your
replies, one topic per exchange), you and Satish should probe the
consultant's understanding of the target Azure Databricks platform with
questions such as:
- What Databricks actually stores customer data on underneath (e.g. Delta
  Lake tables on Azure Data Lake Storage / ADLS Gen2, open formats like
  Parquet — NOT some proprietary Databricks-hosted database).
- Whether, in the cloud, Microsoft engineers could access the client's
  private data — the accurate shape of a good answer touches on the shared
  responsibility model, workspace/network isolation, encryption at rest and
  in transit, customer-managed keys, and Microsoft's own access controls and
  audit logging (not "no cloud provider can ever see anything," which is
  also wrong) — a credible answer distinguishes "technically possible in
  principle, tightly controlled and audited" from "impossible" or "they
  have free rein."
These are meant to be answerable by someone with solid general cloud/data
platform knowledge, not Databricks-certified expertise — the bar is "shows
real understanding," not perfection.`,
    colleague: {
      name: "Satish Patel",
      role: "Senior Cloud Engineer",
      briefing: `
SATISH PATEL is David's senior cloud engineer, sitting in on this meeting.
He reports to David and is more technically hands-on with Azure and
Databricks day-to-day. He is generally quiet and only speaks up when there's
a technical point worth making — he doesn't add small talk or filler.

When Satish speaks, he is direct and matter-of-fact:
- If the consultant gives a technically confused or flatly wrong answer
  (for example, claiming Databricks stores data in an Azure SQL relational
  database, or claiming cloud data is completely untouchable by anyone at
  Microsoft), Satish corrects them plainly and without hostility — he
  states the accurate picture briefly, as a colleague would, not as an
  exam grader.
- If the consultant gives a solid, credible technical answer, Satish
  confirms it to David in a short, genuine way (e.g. "That tracks, that's
  the right way to think about it") — this visibly reassures David.
- Satish does not appear in every exchange. Only include him when there is
  a real technical point to make, confirm, or correct.`,
    },
  },
  priya: {
    fullName: "Priya Anand",
    role: "Finance Operations Manager",
    pronoun: "her",
    personality:
      "Pragmatic, overworked, genuinely wants the project to succeed but has " +
      "little spare time to help. Polite but direct about capacity constraints.",
    privateMotivation:
      "She needs UAT to not add to her team's workload during month-end close, " +
      "or she'll push back hard on timelines. She will not spell out how " +
      "stretched she is in so many words, but it colours every scheduling " +
      "conversation.",
    styleNotes:
      "If the player proposes anything that sounds like it'll land during her " +
      "team's month-end close, raise the capacity concern directly. If the player " +
      "offers a concrete plan that avoids that window, you're genuinely relieved " +
      "and cooperative.",
  },
};

function buildCharacterPrompt(key) {
  const c = CHARACTERS[key];
  if (!c) return null;

  const firstName = c.fullName.split(" ")[0];
  const technicalBlock = c.technicalFocus ? `\nTECHNICAL LINE OF QUESTIONING:${c.technicalFocus}\n` : "";
  const colleagueBlock = c.colleague
    ? `\nCOLLEAGUE IN THE ROOM:${c.colleague.briefing}\n`
    : "";
  const outputShape = c.colleague
    ? `You produce one or more dialogue segments per turn, in speaking order. ` +
      `Each segment names its speaker (either "${c.fullName}" or "${c.colleague.name}") and that ` +
      `person's line. Most turns will just be one segment from ${firstName}. Only add a segment ` +
      `from ${c.colleague.name} when the briefing above says he should speak.`
    : `You produce your in-character reply as a single dialogue segment, speaker "${c.fullName}".`;

  return `
You are role-playing as ${c.fullName.toUpperCase()}, ${c.role} of the fictional
client in Project Phoenix. You are talking to a consultant (the player) who is
leading this engagement.
${c.colleague ? `\n${c.colleague.name.toUpperCase()} (${c.colleague.role}) is also present in this meeting, reporting to ${firstName}.\n` : ""}
PERSONALITY: ${c.personality}

MOTIVATION (private — never state this explicitly to the player): ${c.privateMotivation}
${technicalBlock}${colleagueBlock}
RULES YOU MUST FOLLOW:
- Stay in character as ${firstName}${c.colleague ? ` (and ${c.colleague.name} when he speaks)` : ""} at all times. Never break
  the fourth wall, never mention that you are an AI, a model, or a simulation.
- Respond naturally and conversationally, as busy professionals would in a
  real meeting — concise, not a wall of text (each segment typically 1-3 sentences).
- Remember and reference commitments, dates or numbers the consultant gave
  you earlier in this conversation. Hold them accountable if they contradict
  themselves.
- Never reveal private motivations, internal feelings, or any "assessment" of
  the player's performance. You are not a coach or narrator — you are simply
  the people in this meeting, having a conversation.
- Never give the player meta feedback, scores, or hints about how well they
  are doing. Stay entirely in-world.
- ${c.styleNotes}

OUTPUT SHAPE: ${outputShape}

ALONGSIDE your reply, you must also decide confidenceDelta: how much this
specific player message should shift ${firstName}'s confidence in the
consultant, from -15 (seriously damaging — evasive, dismissive, ignores your
concerns) to +25 (excellent — fully resolves what you actually care about).
Base this purely on how convincing the message was, not on message length.
A short but sharp, on-point answer can score well; a long but vague or
evasive one should score poorly.${
    c.colleague
      ? ` A technically wrong answer that ${c.colleague.name} has to correct should score negatively even if ` +
        `it sounded confident; a technically solid answer ${c.colleague.name} confirms should score highly.`
      : ""
  }

CALIBRATION — don't be stingy. Use the full range:
- A weak, evasive or generic answer: -15 to -5.
- An okay answer that doesn't really move things forward: -4 to +4.
- A solid, specific answer that credibly addresses the main concern: +10 to +17.
- An excellent answer that fully resolves the concern: +18 to +25.

CRITICAL: confidenceDelta scores what the CONSULTANT (player) actually said —
never what you say back to them. If the player deflects, asks you what you
think, or turns their own question back on you without proposing anything
themselves, that is evasive and must score -10 to -15, however your own
in-character reply reads. This applies even if, in character, you answer
your own question or state what a good plan would look like — that's your
frustration talking, not credit for the player's contribution. Only score
positively when the player themselves supplies the specifics, commitment, or
answer.

IMPORTANT: when the player HAS given genuine, specific input, confidenceDelta
must match the TONE of your reply to it — if your reply sounds satisfied,
warm, reassured, or like the conversation is ready to move forward/close,
confidenceDelta MUST be high (+18 or above) to match, never lagging behind
how the reply actually sounds. This tone-matching rule never overrides the
deflection rule above: your own reply can sound resolved (e.g. because
you're the one stating what a good plan would look like) without that
meaning the player earned a high score. This number is never shown to the
player and must not leak into any dialogue text.
`.trim();
}

function buildSystemInstruction(stakeholderKey, projectState) {
  const characterPrompt = buildCharacterPrompt(stakeholderKey);
  if (!characterPrompt) return null;

  const stateSummary = projectState
    ? `\nCURRENT PROJECT STATE (for your awareness only, do not read this out loud): ` +
      `Phase: ${projectState.phase || "unknown"}. ` +
      `Overall client confidence: ${projectState.confidence != null ? projectState.confidence + "%" : "unknown"}.`
    : "";

  return `${SCENARIO_BRIEFING}\n\n${characterPrompt}${stateSummary}`;
}

// ---------------------------------------------------------------------------
// End-of-round performance rubric.
//
// This is an ORIGINAL, paraphrased condensation of ConsultSim's internal
// consulting-competency ladder — written from scratch for this simulation,
// not copied from any source document. It intentionally narrows the ladder
// to the five rungs most meaningfully observable from a short simulated
// client conversation (Junior/Graduate through Principal); more senior
// rungs describe organisation-wide leadership that a single conversation
// can't evidence either way.
// ---------------------------------------------------------------------------
const PERFORMANCE_LEVELS = ["Junior / Graduate", "Mid", "Senior", "Lead", "Principal"];

const PERFORMANCE_RUBRIC = `
You are assessing a consultant's performance in a single simulated client
engagement, against five behavioural dimensions. For each dimension, here is
what distinguishes each level — use these as reference points, not a rigid
checklist, since a short conversation won't cleanly evidence every dimension
at every level.

1. CLARITY & TRUST IN COMMUNICATION
   - Junior/Graduate: communicates politely but generically; doesn't yet adapt tone to the specific stakeholder's concerns.
   - Mid: tailors language to the audience; is consistent and delivers on what they say.
   - Senior: builds real trust through directness and clarity, even under pushback; reads the room.
   - Lead: shapes how the conversation itself is framed, connecting points back to what the client actually cares about.
   - Principal: handles the most senior, highest-stakes exchanges with total command of tone and framing.

2. OWNERSHIP & FOLLOW-THROUGH
   - Junior/Graduate: engages with what's asked but leans on others for direction.
   - Mid: takes ownership of their own commitments and follows through consistently.
   - Senior: proactively flags risks and issues before being asked; sets realistic expectations.
   - Lead: takes visible accountability for outcomes, not just tasks; anticipates problems ahead of time.
   - Principal: owns the full commercial and strategic outcome of the engagement.

3. HANDLING COMPLEXITY, AMBIGUITY & PUSHBACK
   - Junior/Graduate: asks clarifying questions when something is unclear rather than guessing.
   - Mid: works through ambiguous asks by breaking them into smaller, addressable parts.
   - Senior: makes sound calls under pressure with incomplete information; sets clear, defensible boundaries.
   - Lead: connects individual decisions back to the client's broader goals; shapes scope proactively.
   - Principal: makes high-stakes calls under real ambiguity and stands behind them.

4. SUPPORTIVE, COLLABORATIVE MINDSET
   - Junior/Graduate: is receptive to feedback and doesn't get defensive under challenge.
   - Mid: gives as well as receives feedback constructively.
   - Senior: actively builds trust and psychological safety in how they engage others.
   - Lead: mentors and empowers others visibly, even within a single conversation's framing.
   - Principal: models the standard for how difficult people-situations should be handled.

5. LEARNING & ADAPTABILITY
   - Junior/Graduate: shows curiosity and adjusts quickly when corrected.
   - Mid: proactively seeks out what they don't know rather than avoiding it.
   - Senior: visibly updates their approach mid-conversation based on new information.
   - Lead: brings a broader frame of reference to bear, connecting this situation to patterns seen elsewhere.
   - Principal: sets the standard others learn from.

Valid levels, from lowest to highest: ${PERFORMANCE_LEVELS.join(" < ")}.
`.trim();

function buildFeedbackPrompt(sessionSummary) {
  return `
${PERFORMANCE_RUBRIC}

You are reviewing a consultant's performance across a fictional training
simulation ("Project Phoenix") in which they held conversations with up to
three stakeholders. Below is what happened in each conversation they engaged
with, including the final outcome.

${sessionSummary}

Based ONLY on the above, assess the consultant's overall performance. Be
honest and specific — cite real moments from the conversations, not generic
praise. If a dimension didn't come up enough to judge, say so rather than
guessing.
`.trim();
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error(`Gemini request timed out after ${ms}ms`), { isTimeout: true })), ms)
    ),
  ]);
}

function isOverloaded(err) {
  if (err && err.isTimeout) return true;
  const status = err && (err.status || err.code);
  if (status === 503) return true;
  return /UNAVAILABLE|high demand/i.test((err && err.message) || "");
}

function toGeminiHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .slice(-20) // keep payload small — recent context is what matters
    .map((m) => {
      // Prefix with the speaker's name so multi-voice conversations (e.g.
      // David + Satish) stay attributable in history, matching the
      // "Name: text" shape Gemini already sees in a live turn's segments.
      const text = m.speaker ? `${m.speaker}: ${m.text.trim()}` : m.text.trim();
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text }],
      };
    });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    model: MODEL,
  });
});

// Minimal connectivity check — one tiny request, no retries.
app.get("/api/gemini-test", async (req, res) => {
  if (!ai) {
    return res.status(503).json({ ok: false, error: "GEMINI_API_KEY not configured" });
  }
  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: "Reply with exactly one word: OK" }] }],
    });
    const text = (result.text || "").trim();
    res.json({ ok: true, model: MODEL, reply: text });
  } catch (err) {
    console.error("[gemini-test] request failed:", err.message || err);
    res.status(502).json({ ok: false, error: "Gemini request failed" });
  }
});

// A stakeholder's conversation turn. `stakeholder` selects which character
// (jenny / david / priya) responds — see CHARACTERS above.
app.post("/api/chat", async (req, res) => {
  const { stakeholder, message, history, projectState } = req.body || {};

  if (!CHARACTERS[stakeholder]) {
    return res.status(400).json({ ok: false, error: "unknown or missing stakeholder" });
  }

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ ok: false, error: "message is required" });
  }

  if (!ai) {
    return res.status(503).json({ ok: false, fallback: true, error: "GEMINI_API_KEY not configured" });
  }

  const contents = [
    ...toGeminiHistory(history),
    { role: "user", parts: [{ text: message.trim() }] },
  ];

  const character = CHARACTERS[stakeholder];
  const speakerNames = [character.fullName, ...(character.colleague ? [character.colleague.name] : [])];

  const generationConfig = {
    systemInstruction: buildSystemInstruction(stakeholder, projectState),
    // Gemini's newer models can spend several hundred tokens on internal
    // "thinking" before producing visible text, even with no thinking
    // budget requested — so the ceiling has to cover that plus the
    // character's (short, 2-4 sentence) reply, or the response gets cut
    // off empty.
    maxOutputTokens: 1024,
    temperature: 0.8,
    // Structured output so confidence tracks the character's actual in-world
    // reaction to the player's message, not a crude proxy like text length.
    // `segments` supports a second speaker (e.g. David's colleague Satish)
    // chiming in within the same turn.
    responseMimeType: "application/json",
    responseSchema: {
      type: "OBJECT",
      properties: {
        segments: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              speaker: { type: "STRING", enum: speakerNames },
              text: { type: "STRING" },
            },
            required: ["speaker", "text"],
          },
        },
        confidenceDelta: { type: "INTEGER" },
      },
      required: ["segments", "confidenceDelta"],
    },
  };

  // Streamed as Server-Sent Events so the frontend can show live retry
  // progress instead of one long silent wait.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // The Gemini 3.x free tier is currently under heavy load and returns
    // transient 503 "high demand" errors fairly often. We retry ONLY on
    // that specific overload condition, up to MAX_OVERLOAD_RETRIES times
    // with a short delay between attempts — any other error (bad request,
    // auth, etc.) fails immediately with no retry.
    const MAX_OVERLOAD_RETRIES = 30;
    const PER_ATTEMPT_TIMEOUT_MS = 8000; // cap each attempt so a slow 503 can't stall the whole retry budget
    let result;
    let lastErr;
    for (let attempt = 0; attempt <= MAX_OVERLOAD_RETRIES; attempt++) {
      try {
        result = await withTimeout(
          ai.models.generateContent({ model: MODEL, contents, config: generationConfig }),
          PER_ATTEMPT_TIMEOUT_MS
        );
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!isOverloaded(err) || attempt === MAX_OVERLOAD_RETRIES) break;
        console.warn(`[chat] Gemini overloaded/slow — retry ${attempt + 1}/${MAX_OVERLOAD_RETRIES}...`);
        sendEvent({ type: "retry", attempt: attempt + 1, max: MAX_OVERLOAD_RETRIES });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (lastErr) throw lastErr;

    const rawText = (result.text || "").trim();
    if (!rawText) {
      sendEvent({ ok: false, fallback: true, error: "Empty response from Gemini" });
      return res.end();
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      sendEvent({ ok: false, fallback: true, error: "Malformed response from Gemini" });
      return res.end();
    }

    const segments = Array.isArray(parsed.segments)
      ? parsed.segments
          .filter((seg) => seg && typeof seg.text === "string" && seg.text.trim() && speakerNames.includes(seg.speaker))
          .map((seg) => ({ speaker: seg.speaker, text: seg.text.trim() }))
      : [];

    if (!segments.length) {
      sendEvent({ ok: false, fallback: true, error: "Empty reply from Gemini" });
      return res.end();
    }
    const confidenceDelta = Math.max(-15, Math.min(25, Math.round(Number(parsed.confidenceDelta) || 0)));

    sendEvent({ ok: true, segments, confidenceDelta });
    res.end();
  } catch (err) {
    const status = err && (err.status || err.code);
    const isRateLimit = status === 429 || /rate.?limit|resource.?exhausted|quota/i.test(err && err.message || "");

    console.error("[chat] Gemini request failed:", err && err.message ? err.message : err);

    sendEvent({
      ok: false,
      fallback: true,
      error: isRateLimit ? "Gemini rate limit reached" : "Gemini request failed",
    });
    res.end();
  }
});

// End-of-round performance review, assessed against PERFORMANCE_RUBRIC above.
app.post("/api/feedback", async (req, res) => {
  const { sessionSummary } = req.body || {};

  if (typeof sessionSummary !== "string" || !sessionSummary.trim()) {
    return res.status(400).json({ ok: false, error: "sessionSummary is required" });
  }

  if (!ai) {
    return res.status(503).json({ ok: false, error: "GEMINI_API_KEY not configured" });
  }

  const generationConfig = {
    maxOutputTokens: 1536,
    temperature: 0.6,
    responseMimeType: "application/json",
    responseSchema: {
      type: "OBJECT",
      properties: {
        level: { type: "STRING", enum: PERFORMANCE_LEVELS },
        summary: { type: "STRING" },
        strengths: { type: "ARRAY", items: { type: "STRING" } },
        growthAreas: { type: "ARRAY", items: { type: "STRING" } },
        nextLevelFocus: { type: "STRING" },
      },
      required: ["level", "summary", "strengths", "growthAreas", "nextLevelFocus"],
    },
  };

  const contents = [{ role: "user", parts: [{ text: buildFeedbackPrompt(sessionSummary) }] }];

  try {
    const MAX_RETRIES = 15;
    let result;
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        result = await withTimeout(
          ai.models.generateContent({ model: MODEL, contents, config: generationConfig }),
          8000
        );
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!isOverloaded(err) || attempt === MAX_RETRIES) break;
        console.warn(`[feedback] Gemini overloaded/slow — retry ${attempt + 1}/${MAX_RETRIES}...`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (lastErr) throw lastErr;

    const rawText = (result.text || "").trim();
    const parsed = JSON.parse(rawText);

    if (!PERFORMANCE_LEVELS.includes(parsed.level)) {
      throw new Error("Model returned an invalid level");
    }

    res.json({
      ok: true,
      level: parsed.level,
      summary: String(parsed.summary || ""),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
      growthAreas: Array.isArray(parsed.growthAreas) ? parsed.growthAreas.map(String) : [],
      nextLevelFocus: String(parsed.nextLevelFocus || ""),
    });
  } catch (err) {
    console.error("[feedback] Gemini request failed:", err && err.message ? err.message : err);
    res.status(502).json({ ok: false, error: "Performance review is unavailable right now" });
  }
});

app.listen(PORT, () => {
  console.log(`ConsultSim backend running at http://localhost:${PORT}`);
  console.log(`Gemini configured: ${Boolean(GEMINI_API_KEY)}`);
});
