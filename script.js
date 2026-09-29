// ConsultSim — prototype logic.
// All three stakeholders are backed by the local Node/Gemini backend
// (server.js) via their `key`, falling back to their own canned replies
// if a request fails. Each stakeholder tracks its own confidence score,
// conversation transcript and win/lost status, all persisted across
// switching between stakeholders until "Restart Simulation" is pressed.

const WIN_THRESHOLD = 80;
const LOSE_THRESHOLD = 30;

// Simple, deliberately blunt detector for outright insults/abuse directed
// at a stakeholder. Checked locally (no API call) so an obviously
// outrageous message never even reaches Gemini.
const INSULT_PATTERNS = [
  /\bmorons?\b/i,
  /\bidiots?\b/i,
  /\bidiotic\b/i,
  /\bstupid\b/i,
  /\bdumb ?ass\b/i,
  /\bpathetic\b/i,
  /\bincompetent\b/i,
  /\bworthless\b/i,
  /\blosers?\b/i,
  /\bshut up\b/i,
  /\bscrew you\b/i,
  /\bf+\W*u+\W*c+\W*k+/i,
  /\ba+\W*s+\W*s+\W*h+\W*o+\W*l+\W*e+/i,
  /\bb\W*i\W*t\W*c\W*h\b/i
];

function isOutrageous(text) {
  return INSULT_PATTERNS.some((re) => re.test(text));
}

const stakeholders = [
  {
    key: "jenny",
    initials: "JM",
    name: "Jenny Mensah",
    role: "Chief Financial Officer",
    avatarClass: "avatar-1",
    opener:
      "Good morning. Before we go further — I need to understand how you're going to guarantee " +
      "month-end close drops from 9 days to 3. The board is asking me for a date, and I don't " +
      "have one to give them yet.",
    replies: [
      "I hear you, but I need specifics, not reassurance. What's the actual plan?",
      "Alright — that's a clearer answer than I expected. Put it in writing for the board pack.",
      "Noted. I'll hold you to that timeline.",
      "That's useful context. Keep me posted on the Finance pilot progress."
    ],
    insultLine:
      "Excuse me? I won't be spoken to like that. This meeting is over — I'll be raising this with your engagement lead.",
    winLine: "You've clearly got a handle on this. I'm satisfied — let's move forward.",
    loseLine: "I don't think this is working. I need to escalate this internally.",
    startConfidence: 50
  },
  {
    key: "david",
    initials: "DK",
    name: "David Kowalski",
    role: "Head of IT Infrastructure",
    avatarClass: "avatar-2",
    opener:
      "Look, I've been managing this environment for eleven years. I'm not against change, but " +
      "I need to know my team isn't going to get steamrolled by a migration plan we had no say in.",
    replies: [
      "That's the kind of thing I was worried you'd say. My team needs to be involved from day one.",
      "Okay. If you genuinely mean that, I can work with it.",
      "Fine — but I want a named point of contact on your side, not a rotating cast.",
      "That actually addresses my concern. Thank you for being straight with me."
    ],
    insultLine: "That's completely out of line. We're done here.",
    winLine: "Alright, I'm convinced. You've got my team's backing.",
    loseLine: "I'm not comfortable continuing this conversation — I'll be flagging this up.",
    startConfidence: 35
  },
  {
    key: "priya",
    initials: "PA",
    name: "Priya Anand",
    role: "Finance Operations Manager",
    avatarClass: "avatar-3",
    opener:
      "Honestly, I want this to work — our current reporting process is painful. But my team is " +
      "buried during month-end close. If UAT lands in that window, we simply won't have capacity.",
    replies: [
      "I appreciate you saying that, but 'we'll try to work around it' isn't a commitment.",
      "Okay, that sounds workable. Can you confirm the UAT window in writing?",
      "That would genuinely help. Thank you for listening.",
      "Good — let's make sure that's reflected in the project plan."
    ],
    insultLine: "I don't have to put up with that. This conversation is over.",
    winLine: "This is exactly the kind of clarity I needed. I'm on board.",
    loseLine: "I can't keep going around in circles like this. I need to step back from this conversation.",
    startConfidence: 65
  },
  {
    key: "ben",
    initials: "BC",
    name: "Ben Carter",
    role: "Junior Developer",
    avatarClass: "avatar-4",
    // No scoring for this conversation — no confidence bar, no win/loss, no
    // hard fail. It's a supportive check-in, assessed qualitatively only.
    noScoring: true,
    opener:
      "Hey — have you got a minute? I don't really know who else to ask about this... I've been " +
      "staring at the Databricks notebooks for two days and I still don't feel like I understand " +
      "what I'm doing. I don't want to let the team down but I'm honestly a bit overwhelmed.",
    replies: [
      "Yeah... thanks, that actually helps a bit.",
      "I guess I just didn't want to look like I couldn't handle it.",
      "Okay. I think I can try that.",
      "Thanks for listening — I mean it."
    ]
  }
];

function initStakeholderRuntimeState(s) {
  s.confidence = s.startConfidence;
  s.status = "active"; // "active" | "won" | "lost"
  s.transcript = [{ role: "assistant", text: s.opener, speaker: s.name }];
  s.replyIndex = 0;
  s.messageCount = 0; // player messages sent — used for the grace period below
}

// A stakeholder can't be lost on confidence alone until the player has had
// at least this many messages to recover — one rough answer shouldn't end
// the whole round outright. Insults are exempt: those end things immediately
// regardless of grace, since that's a deliberate, unambiguous action.
const LOSS_GRACE_MESSAGES = 2;

stakeholders.forEach(initStakeholderRuntimeState);

// Mutable simulation state
const state = {
  activeStakeholder: 0,
  actionCount: 0,
  roundStatus: "active", // "active" | "gameover" — losing ANY stakeholder ends the whole round
  gameOverStakeholder: null
};

function show(screenId) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");
}

// --- Navigation wiring ---
document.getElementById("btn-start").addEventListener("click", () => show("screen-briefing"));
document.getElementById("btn-back-welcome").addEventListener("click", () => show("screen-welcome"));
document.getElementById("btn-to-stakeholders").addEventListener("click", () => show("screen-stakeholders"));
document.getElementById("btn-back-briefing").addEventListener("click", () => show("screen-briefing"));
document.getElementById("btn-to-simulation").addEventListener("click", () => show("screen-simulation"));
document.getElementById("btn-back-stakeholders").addEventListener("click", () => show("screen-stakeholders"));
document.getElementById("btn-restart").addEventListener("click", restartSimulation);
document.getElementById("btn-view-feedback").addEventListener("click", () => {
  show("screen-feedback");
  loadFeedback();
});
document.getElementById("btn-feedback-back").addEventListener("click", () => show("screen-simulation"));
document.getElementById("btn-feedback-restart").addEventListener("click", restartSimulation);
document.getElementById("btn-retry-feedback").addEventListener("click", loadFeedback);

// --- Stakeholder switching ---
document.querySelectorAll(".switch-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".switch-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.activeStakeholder = parseInt(btn.dataset.stakeholder, 10);
    renderActiveStakeholder();
  });
});

function renderActiveStakeholder() {
  const s = stakeholders[state.activeStakeholder];
  const avatarEl = document.getElementById("active-avatar");
  avatarEl.textContent = s.initials;
  avatarEl.className = "avatar avatar-sm " + s.avatarClass;
  document.getElementById("active-name").textContent = s.name;
  document.getElementById("active-role").textContent = s.role;

  const messages = document.getElementById("messages");
  messages.innerHTML = "";
  s.transcript.forEach((entry) => renderMessageBubble(entry.text, entry.role, entry.speaker, s.name));
  messages.scrollTop = messages.scrollHeight;

  updateConfidenceMeter();
  updateComposerAndBanner();
}

// `speaker` is who's actually talking (e.g. "Satish Patel"); `primaryName` is
// the stakeholder whose conversation this is (e.g. "David Kowalski"). A
// speaker label is only shown when a second voice — like David's colleague
// Satish — chimes in, to keep the common single-speaker case uncluttered.
function renderMessageBubble(text, role, speaker, primaryName) {
  const messages = document.getElementById("messages");
  const wrapper = document.createElement("div");
  wrapper.className = "message " + (role === "assistant" ? "message-them" : "message-me");

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  if (role === "assistant" && speaker && speaker !== primaryName) {
    const label = document.createElement("div");
    label.className = "message-speaker";
    label.textContent = speaker;
    bubble.appendChild(label);
  }

  const textEl = document.createElement("div");
  textEl.textContent = text;
  bubble.appendChild(textEl);

  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
}

// Appends a message to a stakeholder's persistent transcript, and renders
// it immediately only if that stakeholder is the one currently on screen.
// `speaker` defaults to the stakeholder's own name (set by callers for
// clarity in multi-voice conversations like David's with Satish).
function appendMessage(idx, text, role, speaker) {
  const s = stakeholders[idx];
  const resolvedSpeaker = speaker || (role === "assistant" ? s.name : undefined);
  s.transcript.push({ role, text, speaker: resolvedSpeaker });
  if (idx === state.activeStakeholder) {
    renderMessageBubble(text, role, resolvedSpeaker, s.name);
  }
}

function showTypingIndicator(text) {
  const messages = document.getElementById("messages");
  const wrapper = document.createElement("div");
  wrapper.className = "message message-them";
  wrapper.id = "typing-indicator";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = text || "…";
  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
}

function updateTypingIndicator(text) {
  const el = document.getElementById("typing-indicator");
  if (el) {
    el.querySelector(".message-bubble").textContent = text;
    document.getElementById("messages").scrollTop = document.getElementById("messages").scrollHeight;
  } else {
    showTypingIndicator(text);
  }
}

function removeTypingIndicator() {
  const el = document.getElementById("typing-indicator");
  if (el) el.remove();
}

// --- Sending a response ---
document.getElementById("btn-send").addEventListener("click", sendResponse);
document.getElementById("player-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendResponse();
  }
});

async function sendResponse() {
  const idx = state.activeStakeholder;
  const s = stakeholders[idx];

  // Ben's check-in is independent of the scored round — it stays open even
  // after a game-over on the client stakeholders, since it was never part
  // of that pass/fail engagement in the first place.
  if (!s.noScoring) {
    if (state.roundStatus === "gameover") return; // whole round already over
    if (s.status !== "active") return; // conversation already concluded — composer is disabled anyway
  }

  const input = document.getElementById("player-input");
  const text = input.value.trim();
  if (!text) return;

  appendMessage(idx, text, "user");
  input.value = "";

  logAction(`Responded to ${s.name}`);

  // Ben's conversation is a qualitative, unscored check-in — no insult
  // detection, no confidence, no win/loss. Just get his reply and stop.
  if (s.noScoring) {
    await getReplyAndDelta(text, idx);
    return;
  }

  s.messageCount++;

  if (isOutrageous(text)) {
    applyConfidenceDelta(idx, -s.confidence); // straight to zero
    logAction(`${s.name} was insulted — confidence trashed`);
    setTimeout(() => {
      appendMessage(idx, s.insultLine, "assistant");
      concludeConversation(idx, "lost");
    }, 500);
    return;
  }

  const delta = await getReplyAndDelta(text, idx);
  const pendingEnding = applyConfidenceDelta(idx, delta);

  if (pendingEnding) {
    setTimeout(() => {
      appendMessage(idx, pendingEnding === "won" ? s.winLine : s.loseLine, "assistant");
      concludeConversation(idx, pendingEnding);
    }, 500);
  }
}

function sendCannedReply(idx) {
  const s = stakeholders[idx];
  const replyPool = s.replies;
  const nextReply = replyPool[Math.min(s.replyIndex, replyPool.length - 1)];
  s.replyIndex = Math.min(s.replyIndex + 1, replyPool.length - 1);

  return new Promise((resolve) => {
    setTimeout(() => {
      appendMessage(idx, nextReply, "assistant");
      resolve();
    }, 500);
  });
}

// Sends the player's message, appends the stakeholder's reply (Gemini or
// canned fallback) to their transcript, and returns the confidence delta
// this exchange should apply — Gemini's own in-character judgment when
// available, or a crude length-based fallback when it isn't.
async function getReplyAndDelta(message, idx) {
  const s = stakeholders[idx];
  const firstName = s.name.split(" ")[0];
  if (idx === state.activeStakeholder) showTypingIndicator(`${firstName} is typing…`);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stakeholder: s.key,
        message,
        // Exclude the scripted opener (transcript[0]) from the context sent
        // to Gemini — only actual exchanged turns count as history.
        history: s.transcript.slice(1),
        projectState: {
          phase: "Discovery — Week 2 of 20",
          confidence: s.confidence
        }
      })
    });

    if (!response.ok || !response.body) {
      throw new Error(`Request failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop(); // keep any incomplete trailing chunk for next read

      for (const chunk of events) {
        const line = chunk.trim();
        if (!line.startsWith("data:")) continue;
        const data = JSON.parse(line.slice(5).trim());

        if (data.type === "retry") {
          if (idx === state.activeStakeholder) {
            updateTypingIndicator(`${firstName} is thinking… (retry ${data.attempt}/${data.max})`);
          }
        } else {
          finalData = data; // the terminal { ok, reply } or { ok:false, ... } event
        }
      }
    }

    if (idx === state.activeStakeholder) removeTypingIndicator();

    if (!finalData || !finalData.ok) {
      throw new Error((finalData && finalData.error) || "Request failed");
    }

    // `segments` supports more than one speaker in a single turn (e.g.
    // David's colleague Satish chiming in on a technical point).
    (finalData.segments || []).forEach((seg) => {
      appendMessage(idx, seg.text, "assistant", seg.speaker);
    });
    // Gemini's own in-character judgment of how convincing this message was.
    return typeof finalData.confidenceDelta === "number" ? finalData.confidenceDelta : computeDelta(message);
  } catch (err) {
    if (idx === state.activeStakeholder) removeTypingIndicator();
    console.warn(`Gemini reply unavailable for ${s.name}, falling back to canned response:`, err.message || err);
    // Fall back to a canned reply for just this message — no automatic retry —
    // but the next player message still gets its own fresh Gemini attempt.
    // No Gemini judgment available here, so fall back to the crude heuristic.
    await sendCannedReply(idx);
    return computeDelta(message);
  }
}

function computeDelta(text) {
  // Simple heuristic placeholder (canned-reply fallback only, when Gemini's
  // own judgment isn't available): longer, more considered responses nudge
  // confidence up; short/dismissive ones knock it down. Scaled to match
  // Gemini's -15..+25 calibration so the fallback path isn't punishingly slow.
  if (text.length > 100) return 14;
  if (text.length > 40) return 7;
  return -8;
}

// Applies a confidence change to a stakeholder, updates their sentiment tag
// (and the main meter if they're the active stakeholder), and returns
// "won" / "lost" if this change just crossed a threshold, else null.
//
// Losing below LOSE_THRESHOLD is momentum-based, not a flat floor: once past
// the grace period, a message only loses the conversation if confidence
// actually DROPPED and landed at or below the threshold — whether that's
// falling from above the line, or falling further while already below it.
// Recovering upward while still below the threshold keeps you in the game,
// however small the improvement, since you're heading the right way.
function applyConfidenceDelta(idx, delta) {
  const s = stakeholders[idx];
  if (s.status !== "active") return null;

  const previousConfidence = s.confidence;
  s.confidence = Math.max(0, Math.min(100, s.confidence + delta));

  updateSentimentRow(idx);
  if (idx === state.activeStakeholder) updateConfidenceMeter();

  if (s.confidence >= WIN_THRESHOLD) return "won";

  const pastGrace = s.messageCount >= LOSS_GRACE_MESSAGES;
  const droppedToOrBelowThreshold = s.confidence <= LOSE_THRESHOLD && s.confidence < previousConfidence;
  if (pastGrace && droppedToOrBelowThreshold) return "lost";

  return null;
}

function concludeConversation(idx, outcome) {
  const s = stakeholders[idx];
  s.status = outcome; // "won" | "lost"
  updateSentimentRow(idx);
  logAction(`Conversation with ${s.name} ended — ${outcome === "won" ? "Won" : "Lost"}`);

  if (outcome === "lost") {
    // Losing any one stakeholder ends the whole round — game over.
    state.roundStatus = "gameover";
    state.gameOverStakeholder = s.name;
    stakeholders.forEach((other, otherIdx) => {
      if (otherIdx !== idx && other.status === "active") {
        other.status = "lost";
        updateSentimentRow(otherIdx);
      }
    });
    logAction(`GAME OVER — losing ${s.name} ended the engagement`);
  }

  updateConfidenceMeter();
  updateComposerAndBanner();
  checkRoundComplete();
}

// The round is complete once every SCORED stakeholder has been won, or the
// round has been ended early by a loss (which cascades to "lost" for all
// scored stakeholders). Ben's unscored check-in doesn't factor in either way.
function checkRoundComplete() {
  const scored = stakeholders.filter((s) => !s.noScoring);
  const complete = state.roundStatus === "gameover" || scored.every((s) => s.status === "won");
  document.getElementById("btn-view-feedback").hidden = !complete;
}

function labelForStakeholder(s) {
  if (s.status === "won") return { text: "Won", cls: "sentiment-won" };
  if (s.status === "lost") return { text: "Lost", cls: "sentiment-lost" };
  if (s.confidence >= 65) return { text: "Supportive", cls: "sentiment-positive" };
  if (s.confidence >= 45) return { text: "Neutral", cls: "sentiment-neutral" };
  return { text: "Wary", cls: "sentiment-wary" };
}

function updateSentimentRow(idx) {
  const rows = document.querySelectorAll(".sentiment-row");
  const row = rows[idx];
  if (!row) return;
  const tag = row.querySelector(".sentiment-tag");
  const label = labelForStakeholder(stakeholders[idx]);
  tag.textContent = label.text;
  tag.className = "sentiment-tag " + label.cls;
}

function captionForStakeholder(s) {
  if (s.status === "won") return "Conversation won — full confidence secured";
  if (s.status === "lost") return "Conversation lost — replay to try again";
  if (s.confidence >= 65) return "Confident — the client trusts your direction";
  if (s.confidence >= 45) return "Cautiously optimistic";
  if (s.confidence > LOSE_THRESHOLD) return "Uncertain — the client has doubts";
  return "At risk — confidence is critically low";
}

function updateConfidenceMeter() {
  const s = stakeholders[state.activeStakeholder];
  const block = document.getElementById("confidence-block");

  if (s.noScoring) {
    block.classList.add("confidence-qualitative");
    document.getElementById("confidence-label").textContent = `Conversation with ${s.name}`;
    document.getElementById("confidence-caption").textContent =
      "No score here — this is a supportive check-in, assessed qualitatively at the end.";
    return;
  }

  block.classList.remove("confidence-qualitative");
  document.getElementById("confidence-label").textContent = `Client Confidence — ${s.name}`;
  document.getElementById("meter-confidence").style.width = s.confidence + "%";
  document.getElementById("confidence-caption").textContent = `${s.confidence}% — ${captionForStakeholder(s)}`;
}

function updateComposerAndBanner() {
  const s = stakeholders[state.activeStakeholder];
  const input = document.getElementById("player-input");
  const sendBtn = document.getElementById("btn-send");
  const banner = document.getElementById("conversation-banner");

  // Ben's conversation never locks and never shows a banner — it's not
  // part of the pass/fail round.
  if (s.noScoring) {
    input.disabled = false;
    sendBtn.disabled = false;
    banner.hidden = true;
    banner.className = "conversation-banner";
    return;
  }

  const concluded = s.status !== "active";
  input.disabled = concluded;
  sendBtn.disabled = concluded;

  if (!concluded) {
    banner.hidden = true;
    banner.className = "conversation-banner";
    return;
  }

  banner.hidden = false;

  if (state.roundStatus === "gameover") {
    banner.className = "conversation-banner banner-lost";
    banner.textContent =
      s.name === state.gameOverStakeholder
        ? `❌ GAME OVER — losing ${s.name} ended the whole engagement. Restart the simulation to try again.`
        : `❌ GAME OVER — losing ${state.gameOverStakeholder} ended the whole engagement, so this conversation is over too. Restart the simulation to try again.`;
    return;
  }

  banner.className = "conversation-banner " + (s.status === "won" ? "banner-won" : "banner-lost");
  banner.textContent =
    s.status === "won"
      ? `✅ Won — ${s.name} is fully on board. Restart the simulation to play again.`
      : `❌ Lost — ${s.name} has ended the conversation. Restart the simulation to try again.`;
}

function logAction(text) {
  state.actionCount++;
  const log = document.getElementById("action-log");
  const emptyEl = log.querySelector(".log-empty");
  if (emptyEl) emptyEl.remove();

  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  item.textContent = `[${time}] ${text}`;
  log.prepend(item);
}

function restartSimulation() {
  state.activeStakeholder = 0;
  state.actionCount = 0;
  state.roundStatus = "active";
  state.gameOverStakeholder = null;
  stakeholders.forEach(initStakeholderRuntimeState);

  document.querySelectorAll(".switch-btn").forEach(b => b.classList.remove("active"));
  document.querySelector('.switch-btn[data-stakeholder="0"]').classList.add("active");

  stakeholders.forEach((_, idx) => updateSentimentRow(idx));

  const log = document.getElementById("action-log");
  log.innerHTML = '<li class="log-empty">No actions taken yet.</li>';

  document.getElementById("btn-view-feedback").hidden = true;
  document.getElementById("feedback-content").hidden = true;
  document.getElementById("feedback-error").hidden = true;
  document.getElementById("feedback-loading").hidden = true;

  show("screen-simulation");
  renderActiveStakeholder();
}

// ---------------------------------------------------------------------------
// End-of-round performance review
// ---------------------------------------------------------------------------

function buildSessionSummary() {
  const sections = stakeholders.map((s) => {
    const lines = s.transcript.map((m) => `${m.role === "assistant" ? (m.speaker || s.name) : "Consultant"}: ${m.text}`);

    if (s.noScoring) {
      return (
        `--- Qualitative check-in with ${s.name} (${s.role}) — NOT SCORED, no outcome ---\n` +
        lines.join("\n")
      );
    }

    const outcome = s.status === "won" ? "WON" : s.status === "lost" ? "LOST" : "INCOMPLETE";
    return (
      `--- Conversation with ${s.name} (${s.role}) — Outcome: ${outcome}, Final confidence: ${s.confidence}% ---\n` +
      lines.join("\n")
    );
  });
  return sections.join("\n\n");
}

async function loadFeedback() {
  const loading = document.getElementById("feedback-loading");
  const content = document.getElementById("feedback-content");
  const errorBox = document.getElementById("feedback-error");

  loading.hidden = false;
  content.hidden = true;
  errorBox.hidden = true;

  try {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionSummary: buildSessionSummary() })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Request failed");
    }

    document.getElementById("feedback-level").textContent = data.level;
    document.getElementById("feedback-summary").textContent = data.summary;
    document.getElementById("feedback-next-level").textContent = data.nextLevelFocus;
    document.getElementById("feedback-support-notes").textContent = data.psychologicalSafetyNotes;

    const strengthsList = document.getElementById("feedback-strengths");
    strengthsList.innerHTML = "";
    data.strengths.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      strengthsList.appendChild(li);
    });

    const growthList = document.getElementById("feedback-growth");
    growthList.innerHTML = "";
    data.growthAreas.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      growthList.appendChild(li);
    });

    loading.hidden = true;
    content.hidden = false;
  } catch (err) {
    console.warn("Performance review unavailable:", err.message || err);
    loading.hidden = true;
    content.hidden = true;
    errorBox.hidden = false;
  }
}

// Initial render
stakeholders.forEach((_, idx) => updateSentimentRow(idx));
renderActiveStakeholder();
