// ConsultSim — prototype logic.
// The player picks a scenario (level) from the server's list; everything
// about it — briefing, cast, rules, mid-round events — comes from that
// scenario's JSON (see scenarios/ and lib/scenarios.js). Every stakeholder
// is backed by the local Node/Gemini backend (server.js) via their `key`,
// falling back to their own canned replies if a request fails. Each
// stakeholder tracks its own confidence score, conversation transcript and
// win/lost status, all persisted across switching between stakeholders
// until the scenario is restarted.

// Response-time pressure: the player has this long to reply once a
// stakeholder has spoken. The clock only runs during the player's own
// think time — it's paused (deadline cleared) while waiting on Gemini —
// and runs in the background for every stakeholder at once, not just
// whichever one is currently on screen.
// Per-message response window. No longer fixed: the player sets it on the
// Stakeholders screen by firing a ball down a line (see the launcher section
// below and launcher.js). 120s is only the fallback if that never happens.
let responseTimeLimitMs = 120000;
// The clock turns red for the last 20s — or the last third, if the player
// only negotiated themselves a tiny window.
function responseUrgentSeconds() {
  return Math.min(20, Math.ceil(responseTimeLimitMs / 1000 / 3));
}
const TIMEOUT_CONFIDENCE_PENALTY = -10;
const TIMEOUT_MOOD_PENALTY = -8;

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

// The chosen scenario's cast, with runtime state layered on by
// initStakeholderRuntimeState. Empty until a scenario is picked.
let stakeholders = [];

function initStakeholderRuntimeState(s) {
  s.confidence = s.startConfidence;
  // "active" | "won" | "lost" for scored stakeholders; noScoring stakeholders
  // only ever use "active" | "closed" (manually ended by the player).
  s.status = "active";
  s.transcript = [{ role: "assistant", text: s.opener, speaker: s.name }];
  s.replyIndex = 0;
  // Player messages sent — used for the grace period: a stakeholder can't be
  // lost on confidence alone until the player has had rules.lossGraceMessages
  // messages to recover, so one rough answer doesn't end the whole round
  // outright. Insults are exempt: those end things immediately regardless of
  // grace, since that's a deliberate, unambiguous action.
  s.messageCount = 0;
  s.mood = 0; // noScoring only: silent running emotional trend, never displayed live
  s.review = null; // { headline, notes } once this conversation's quick review has loaded
  s.deadline = null; // timestamp the player must respond by, or null while not their turn to reply
}

// Mutable simulation state
const state = {
  scenario: null, // the chosen scenario, as served by GET /api/scenarios/:id
  activeStakeholder: 0,
  actionCount: 0,
  playerTurns: 0, // messages sent to anyone — what scenario events are timed against
  firedEvents: [], // ids of scenario events that have already happened this round
  roundStatus: "active", // "active" | "gameover" — losing ANY stakeholder ends the whole round
  gameOverStakeholder: null,
  timersStarted: false // becomes true once the player first enters the simulation screen
};

function rules() {
  return state.scenario.rules;
}

function show(screenId) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");
}

// --- Navigation wiring ---
document.getElementById("btn-start").addEventListener("click", () => {
  show("screen-levels");
  loadLevels();
});
document.getElementById("btn-levels-back").addEventListener("click", () => show("screen-welcome"));
document.getElementById("btn-back-welcome").addEventListener("click", () => {
  show("screen-levels");
  loadLevels();
});
document.getElementById("btn-to-stakeholders").addEventListener("click", () => show("screen-stakeholders"));
document.getElementById("btn-back-briefing").addEventListener("click", () => show("screen-briefing"));
document.getElementById("btn-to-simulation").addEventListener("click", () => {
  show("screen-simulation");
  startAllTimersIfNeeded();
});
document.getElementById("btn-back-stakeholders").addEventListener("click", () => show("screen-stakeholders"));
document.getElementById("btn-restart").addEventListener("click", restartSimulation);
document.getElementById("btn-view-feedback").addEventListener("click", () => {
  show("screen-feedback");
  loadFeedback();
});
document.getElementById("btn-feedback-back").addEventListener("click", () => show("screen-simulation"));
document.getElementById("btn-feedback-restart").addEventListener("click", restartSimulation);
document.getElementById("btn-feedback-levels").addEventListener("click", () => {
  show("screen-levels");
  loadLevels();
});
document.getElementById("btn-retry-feedback").addEventListener("click", loadFeedback);
document.getElementById("btn-end-checkin").addEventListener("click", endCheckin);
document.getElementById("btn-view-progress").addEventListener("click", () => {
  show("screen-progress");
  loadProgress();
});
document.getElementById("btn-progress-back").addEventListener("click", () => show("screen-welcome"));

// ---------------------------------------------------------------------------
// Scenario selection and rendering — everything scenario-specific on the
// briefing, stakeholder and simulation screens is built from the scenario
// data here, rather than written into index.html.
// ---------------------------------------------------------------------------

function stars(difficulty) {
  return "★".repeat(difficulty) + "☆".repeat(Math.max(0, 5 - difficulty));
}

async function loadLevels() {
  const container = document.getElementById("level-list");
  container.innerHTML = "";
  container.appendChild(el("p", "progress-status", "Loading scenarios…"));

  try {
    const response = await fetch("/api/scenarios");
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Request failed");

    container.innerHTML = "";
    if (!data.scenarios.length) {
      container.appendChild(el("p", "progress-status", "No scenarios are available — check the server log."));
      return;
    }
    data.scenarios.forEach((scenario) => container.appendChild(renderLevelCard(scenario)));
  } catch (err) {
    console.warn("Could not load scenarios:", err.message || err);
    container.innerHTML = "";
    container.appendChild(el("p", "progress-status", "Could not load scenarios right now."));
  }
}

function renderLevelCard(scenario) {
  const card = el("div", "card level-card");
  card.appendChild(el("div", "level-stars", stars(scenario.difficulty)));
  card.appendChild(el("h3", null, scenario.title));
  card.appendChild(el("div", "role", scenario.projectName));
  card.appendChild(el("p", "level-summary", scenario.summary));

  let record = "Not attempted yet";
  if (scenario.attempts) {
    record = `${scenario.attempts} attempt${scenario.attempts === 1 ? "" : "s"}`;
    if (scenario.bestLevel) record += ` · Best: ${scenario.bestLevel}`;
  }
  const meta = el("div", "level-meta", record);
  if (scenario.cleared) meta.appendChild(el("span", "attempt-badge attempt-badge-won", "Cleared"));
  card.appendChild(meta);

  const playBtn = el("button", "btn btn-primary", scenario.attempts ? "Play Again" : "Play");
  playBtn.addEventListener("click", () => startScenario(scenario.id, playBtn));
  card.appendChild(playBtn);
  return card;
}

async function startScenario(id, button) {
  if (button) button.disabled = true;
  try {
    const response = await fetch(`/api/scenarios/${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Request failed");

    state.scenario = data.scenario;
    renderScenarioScreens();
    resetRound();
    show("screen-briefing");
  } catch (err) {
    console.warn("Could not load scenario:", err.message || err);
    alert("Couldn't load that scenario right now — please try again.");
  } finally {
    if (button) button.disabled = false;
  }
}

function renderScenarioScreens() {
  const sc = state.scenario;
  const display = sc.briefing.display;

  document.getElementById("briefing-stars").textContent = stars(sc.difficulty);
  document.getElementById("briefing-title").textContent = `${sc.projectName} — ${sc.title}`;
  document.getElementById("briefing-summary").textContent = sc.summary;

  const objectives = document.getElementById("briefing-objectives");
  objectives.innerHTML = "";
  display.objectives.forEach((text) => objectives.appendChild(el("li", null, text)));

  const timeline = document.getElementById("briefing-timeline");
  timeline.innerHTML = "";
  (display.timeline || []).forEach((item) => {
    const row = el("div", "timeline-item");
    row.appendChild(el("span", "timeline-date", item.when));
    row.appendChild(el("span", "timeline-desc", item.what));
    timeline.appendChild(row);
  });
  const deadline = document.getElementById("briefing-deadline");
  deadline.textContent = display.deadlineNote || "";
  deadline.hidden = !display.deadlineNote;
  document.getElementById("briefing-timeline-card").hidden = !(display.timeline || []).length && !display.deadlineNote;

  const risks = document.getElementById("briefing-risks");
  risks.innerHTML = "";
  (display.risks || []).forEach((risk) => {
    const item = el("div", `risk-item risk-${risk.level}`);
    item.appendChild(el("span", "risk-label", risk.level[0].toUpperCase() + risk.level.slice(1)));
    item.appendChild(el("p", null, risk.text));
    risks.appendChild(item);
  });
  document.getElementById("briefing-risks-card").hidden = !(display.risks || []).length;

  const grid = document.getElementById("stakeholder-grid");
  grid.innerHTML = "";
  sc.stakeholders.forEach((s) => grid.appendChild(renderStakeholderCard(s)));

  const switcher = document.getElementById("stakeholder-switcher");
  switcher.innerHTML = "";
  sc.stakeholders.forEach((s, idx) => {
    const btn = el("button", "switch-btn", s.initials);
    btn.dataset.stakeholder = idx;
    btn.title = s.name;
    switcher.appendChild(btn);
  });

  const sentiment = document.getElementById("sentiment-rows");
  sentiment.innerHTML = "";
  sc.stakeholders.forEach((s, idx) => {
    if (s.noScoring) return;
    const row = el("div", "sentiment-row");
    row.dataset.idx = idx;
    row.appendChild(el("span", "sentiment-name", s.name));
    row.appendChild(el("span", "sentiment-tag"));
    sentiment.appendChild(row);
  });

  document.getElementById("status-phase").textContent = sc.phase;

  const openRisks = document.getElementById("status-risks");
  openRisks.innerHTML = "";
  sc.openRisks.forEach((text) => openRisks.appendChild(el("li", null, text)));
  document.getElementById("status-risks-block").hidden = !sc.openRisks.length;
}

function renderStakeholderCard(s) {
  const card = el("div", "stakeholder-card" + (s.noScoring ? " stakeholder-card-support" : ""));
  card.appendChild(el("div", `avatar ${s.avatarClass}`, s.initials));
  card.appendChild(el("h3", null, s.name));
  card.appendChild(el("div", "role", s.role));

  const addLine = (cls, label, text) => {
    if (!text) return;
    const p = el("p", cls);
    p.appendChild(el("strong", null, `${label}:`));
    p.appendChild(document.createTextNode(` ${text}`));
    card.appendChild(p);
  };
  const cardText = s.card || {};
  addLine("personality", "Personality", cardText.personality);
  addLine("motivation", "Motivation", cardText.motivation);
  addLine("motivation", "Note", cardText.note);
  return card;
}

function endCheckin() {
  const idx = state.activeStakeholder;
  const s = stakeholders[idx];
  if (!s.noScoring || s.status !== "active") return;

  s.status = "closed";
  s.deadline = null;
  logAction(`Ended check-in with ${s.name}`);
  updateComposerAndBanner();
  updateResponseTimerDisplay();
  requestConversationReview(idx, "closed");
}

// --- Stakeholder switching ---
document.getElementById("stakeholder-switcher").addEventListener("click", (e) => {
  const btn = e.target.closest(".switch-btn");
  if (!btn) return;
  state.activeStakeholder = parseInt(btn.dataset.stakeholder, 10);
  highlightActiveSwitch();
  renderActiveStakeholder();
});

function highlightActiveSwitch() {
  document.querySelectorAll(".switch-btn").forEach((b) => {
    b.classList.toggle("active", parseInt(b.dataset.stakeholder, 10) === state.activeStakeholder);
  });
}

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
  updateResponseTimerDisplay();
}

// `speaker` is who's actually talking (e.g. "Satish Patel"); `primaryName` is
// the stakeholder whose conversation this is (e.g. "David Kowalski"). A
// speaker label is only shown when a second voice — like David's colleague
// Satish — chimes in, to keep the common single-speaker case uncluttered.
function renderMessageBubble(text, role, speaker, primaryName) {
  const messages = document.getElementById("messages");

  // Scenario events (e.g. "go-live has moved") are narration, not dialogue —
  // shown as a centred notice in every conversation.
  if (role === "event") {
    const notice = document.createElement("div");
    notice.className = "message message-event";
    notice.textContent = text;
    messages.appendChild(notice);
    messages.scrollTop = messages.scrollHeight;
    return;
  }

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

// --- Response-time launcher (Stakeholders screen) ---
// Press and hold the plunger, release to fire the ball. Where it stops sets
// responseTimeLimitMs for the round. The maths lives in launcher.js; this is
// just input handling and animation. The chosen time sticks across restarts.
(function initLauncher() {
  const L = window.Launcher;
  if (!L) return;
  const { FULL_CHARGE_MS, MAX_SHOTS, JITTER } = L.LAUNCHER_CONFIG;
  const POWER_BAR_MAX = 1.5; // the power bar shows up to 150% charge; past 100% is the danger zone

  const plunger = document.getElementById("launcher-plunger");
  const ball = document.getElementById("launcher-ball");
  const line = document.querySelector(".launcher-line");
  const powerFill = document.getElementById("launcher-power-fill");
  const timeEl = document.getElementById("launcher-time");
  const zoneEl = document.getElementById("launcher-zone");
  const quipEl = document.getElementById("launcher-quip");
  const shotsEl = document.getElementById("launcher-shots");
  const startBtn = document.getElementById("btn-to-simulation");

  let shotsLeft = MAX_SHOTS;
  let chargeStart = null;
  let chargeRaf = null;
  let flying = false;

  const chargeQuips = [
    [0.25, "Modest ask…"],
    [0.6, "Building a business case…"],
    [0.9, "Ambitious. Procurement is watching."],
    [1.0, "Right at the limit. Let go. LET GO."],
    [1.25, "That's scope creep."],
    [Infinity, "PUT. IT. DOWN."]
  ];

  function setBall(x, y, rot) {
    ball.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg)`;
  }

  function resetBall() {
    ball.classList.remove("launcher-ball-gone");
    setBall(0, 0, 0);
  }

  function updateShots() {
    shotsEl.textContent = shotsLeft === 1 ? "1 shot left" : `${shotsLeft} shots left`;
    if (shotsLeft <= 0) {
      plunger.disabled = true;
      shotsEl.textContent = "no shots left";
    }
  }

  function chargeTick() {
    if (chargeStart == null) return;
    const charge = (performance.now() - chargeStart) / FULL_CHARGE_MS;
    const shown = Math.min(charge, POWER_BAR_MAX);
    powerFill.style.width = `${(shown / POWER_BAR_MAX) * 100}%`;
    powerFill.classList.toggle("launcher-power-danger", charge > 1);
    plunger.style.setProperty("--charge", Math.min(charge, 1).toFixed(3));
    plunger.classList.toggle("launcher-plunger-overcharged", charge > 1);
    quipEl.textContent = chargeQuips.find(([max]) => charge < max)[1];
    chargeRaf = requestAnimationFrame(chargeTick);
  }

  function startCharge(e) {
    if (flying || shotsLeft <= 0 || chargeStart != null) return;
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.pointerId != null && plunger.setPointerCapture) plunger.setPointerCapture(e.pointerId);
    resetBall();
    chargeStart = performance.now();
    plunger.classList.add("launcher-plunger-charging");
    chargeTick();
  }

  function release() {
    if (chargeStart == null) return;
    const holdMs = performance.now() - chargeStart;
    chargeStart = null;
    cancelAnimationFrame(chargeRaf);
    plunger.classList.remove("launcher-plunger-charging", "launcher-plunger-overcharged");
    plunger.style.setProperty("--charge", "0");
    fire(holdMs);
  }

  function fire(holdMs) {
    const jitter = (Math.random() * 2 - 1) * JITTER;
    const result = L.launchResult(holdMs, jitter);
    shotsLeft--;
    flying = true;
    quipEl.textContent = "Negotiating…";

    const range = Math.max(0, line.offsetWidth - ball.offsetWidth);
    // Overshoots keep rolling past the edge, then drop off the cliff.
    const target = Math.min(result.distance, 1.3) * range;
    const duration = 450 + 1000 * Math.sqrt(Math.min(result.distance, 1.3));
    const t0 = performance.now();

    function frame(now) {
      const t = Math.min(1, (now - t0) / duration);
      const eased = result.overshot ? t : 1 - Math.pow(1 - t, 3); // ease-out = friction; overshoots don't slow down
      const x = eased * target;
      const past = Math.max(0, x - range);
      const y = past > 0 ? Math.pow(past, 1.6) * 0.6 : 0; // gravity, roughly
      setBall(x, y, x * 2.2);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        if (result.overshot) ball.classList.add("launcher-ball-gone");
        land(result);
      }
    }
    requestAnimationFrame(frame);
  }

  function land(result) {
    flying = false;
    responseTimeLimitMs = result.seconds * 1000;
    const mm = Math.floor(result.seconds / 60);
    const ss = result.seconds % 60;
    timeEl.textContent = `${mm}:${String(ss).padStart(2, "0")}`;
    zoneEl.textContent = result.zone.label;
    document.getElementById("launcher-readout").classList.toggle("launcher-readout-bad", result.overshot);
    updateShots();
    quipEl.textContent = shotsLeft > 0
      ? `${result.zone.quip} Happy? Start the simulation, or fire again.`
      : `${result.zone.quip} That's your rate card now — no more renegotiation.`;
    startBtn.disabled = false;
    startBtn.removeAttribute("title");
  }

  plunger.addEventListener("pointerdown", startCharge);
  plunger.addEventListener("pointerup", release);
  plunger.addEventListener("pointercancel", release);
  plunger.addEventListener("lostpointercapture", release);
  plunger.addEventListener("contextmenu", (e) => e.preventDefault()); // long-press on touch devices
  plunger.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) startCharge(e);
  });
  plunger.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") release();
  });
  updateShots();
})();

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
  // of that pass/fail engagement in the first place. It still locks once
  // the player has manually ended it via "End Check-in", though.
  if (!s.noScoring) {
    if (state.roundStatus === "gameover") return; // whole round already over
    if (s.status !== "active") return; // conversation already concluded — composer is disabled anyway
  } else if (s.status !== "active") {
    return; // Ben's check-in has already been closed
  }

  const input = document.getElementById("player-input");
  const text = input.value.trim();
  if (!text) return;

  appendMessage(idx, text, "user");
  input.value = "";
  state.playerTurns++;

  // The player just replied — pause their clock while we wait on a
  // response, then restart it once it's their turn again (below).
  s.deadline = null;
  if (idx === state.activeStakeholder) updateResponseTimerDisplay();

  logAction(`Responded to ${s.name}`);

  // Ben's conversation is a qualitative, unscored check-in — no insult
  // detection, no win/loss. We still track a silent internal mood trend
  // (never shown live) so the closing review has real signal to draw on.
  if (s.noScoring) {
    const moodDelta = await getReplyAndDelta(text, idx);
    if (typeof moodDelta === "number") {
      s.mood = Math.max(-50, Math.min(50, s.mood + moodDelta));
    }
    if (s.status === "active") s.deadline = Date.now() + responseTimeLimitMs;
    if (idx === state.activeStakeholder) updateResponseTimerDisplay();
    fireDueEvents();
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
      fireDueEvents();
    }, 500);
  } else {
    s.deadline = Date.now() + responseTimeLimitMs;
    if (idx === state.activeStakeholder) updateResponseTimerDisplay();
    fireDueEvents();
  }
}

// ---------------------------------------------------------------------------
// Scenario events — mid-round twists (a deadline pulled forward, an incident)
// that fire once the player has sent `afterTurns` messages in total, across
// every conversation. An event posts a notice into every transcript, lets
// named stakeholders react in their own conversation, optionally knocks
// every still-active client's confidence, and from then on is included in
// each character's briefing server-side (via projectState.firedEvents).
// ---------------------------------------------------------------------------

function fireDueEvents() {
  if (state.roundStatus === "gameover") return;
  state.scenario.events
    .filter((event) => !state.firedEvents.includes(event.id) && state.playerTurns >= event.afterTurns)
    .forEach(fireEvent);
}

function fireEvent(event) {
  state.firedEvents.push(event.id);
  logAction(`Development: ${event.text}`);

  const list = document.getElementById("status-events");
  list.appendChild(el("li", null, event.text));
  document.getElementById("status-events-block").hidden = false;

  stakeholders.forEach((s, idx) => {
    appendMessage(idx, event.text, "event");
    if (s.status !== "active") return;

    const reaction = event.reactions[s.key];
    if (reaction) appendMessage(idx, reaction, "assistant");

    // Deliberately bypasses applyConfidenceDelta: news landing shouldn't
    // lose the conversation by itself — the player gets to respond first.
    if (!s.noScoring && event.confidenceShift) {
      s.confidence = Math.max(0, Math.min(100, s.confidence + event.confidenceShift));
      updateSentimentRow(idx);
    }
  });
  updateConfidenceMeter();
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
        scenarioId: state.scenario.id,
        stakeholder: s.key,
        message,
        // Exclude the scripted opener (transcript[0]) from the context sent
        // to Gemini — only actual exchanged turns count as history. Event
        // notices are left out too: the server adds fired events to the
        // character's briefing instead, which is where they belong.
        history: s.transcript.slice(1).filter((m) => m.role !== "event"),
        projectState: {
          confidence: s.confidence,
          firedEvents: state.firedEvents
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
    // Gemini's own in-character judgment — confidenceDelta for scored
    // stakeholders, moodDelta for noScoring ones (e.g. Ben).
    if (typeof finalData.confidenceDelta === "number") return finalData.confidenceDelta;
    if (typeof finalData.moodDelta === "number") return finalData.moodDelta;
    return computeDelta(message);
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
// Losing below rules().loseThreshold is momentum-based, not a flat floor: once past
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

  const { winThreshold, loseThreshold, lossGraceMessages } = rules();
  if (s.confidence >= winThreshold) return "won";

  const pastGrace = s.messageCount >= lossGraceMessages;
  const droppedToOrBelowThreshold = s.confidence <= loseThreshold && s.confidence < previousConfidence;
  if (pastGrace && droppedToOrBelowThreshold) return "lost";

  return null;
}

function concludeConversation(idx, outcome) {
  const s = stakeholders[idx];
  s.status = outcome; // "won" | "lost"
  s.deadline = null;
  updateSentimentRow(idx);
  logAction(`Conversation with ${s.name} ended — ${outcome === "won" ? "Won" : "Lost"}`);

  if (outcome === "lost") {
    // Losing any one SCORED stakeholder ends the whole round — game over.
    // Ben's check-in is exempt: it was never part of the pass/fail
    // engagement, so it isn't dragged into the cascade.
    state.roundStatus = "gameover";
    state.gameOverStakeholder = s.name;
    stakeholders.forEach((other, otherIdx) => {
      if (otherIdx !== idx && !other.noScoring && other.status === "active") {
        other.status = "lost";
        other.deadline = null;
        updateSentimentRow(otherIdx);
      }
    });
    logAction(`GAME OVER — losing ${s.name} ended the engagement`);
  }

  updateConfidenceMeter();
  updateComposerAndBanner();
  checkRoundComplete();
  requestConversationReview(idx, outcome);
}

// The round is complete once every SCORED stakeholder has been won, or the
// round has been ended early by a loss (which cascades to "lost" for all
// scored stakeholders). Ben's unscored check-in doesn't factor in either way.
function checkRoundComplete() {
  const scored = stakeholders.filter((s) => !s.noScoring);
  const complete = state.roundStatus === "gameover" || scored.every((s) => s.status === "won");
  document.getElementById("btn-view-feedback").hidden = !complete;
}

// ---------------------------------------------------------------------------
// Response-time pressure
// ---------------------------------------------------------------------------

// Idempotent — safe to call every time the player enters the simulation
// screen. Only actually starts the clocks once per round, so navigating
// back to Stakeholders and forward again mid-round can't be used to farm
// free thinking time.
function startAllTimersIfNeeded() {
  if (state.timersStarted) return;
  state.timersStarted = true;
  const now = Date.now();
  stakeholders.forEach((s) => {
    if (s.status === "active") s.deadline = now + responseTimeLimitMs;
  });
  updateResponseTimerDisplay();
}

// Runs every second in the background for ALL FOUR conversations at once,
// not just whichever one is on screen — switching away doesn't stop anyone's
// clock. Each stakeholder's own deadline is an absolute timestamp, so this
// is accurate regardless of how often (or rarely) it's checked.
function tickTimers() {
  if (!state.timersStarted) return;
  const now = Date.now();
  stakeholders.forEach((s, idx) => {
    if (s.status !== "active" || s.deadline == null) return;
    if (now >= s.deadline) handleResponseTimeout(idx);
  });
  updateResponseTimerDisplay();
}

setInterval(tickTimers, 1000);

function handleResponseTimeout(idx) {
  const s = stakeholders[idx];
  s.deadline = null;
  logAction(`${s.name} grew impatient waiting for a response`);

  if (s.noScoring) {
    s.mood = Math.max(-50, Math.min(50, s.mood + TIMEOUT_MOOD_PENALTY));
    appendMessage(idx, s.timeoutLine, "assistant");
    s.deadline = Date.now() + responseTimeLimitMs; // no hard fail — just a fresh window
    if (idx === state.activeStakeholder) updateComposerAndBanner();
    return;
  }

  const pendingEnding = applyConfidenceDelta(idx, TIMEOUT_CONFIDENCE_PENALTY);
  appendMessage(idx, s.timeoutLine, "assistant");

  if (pendingEnding) {
    concludeConversation(idx, pendingEnding);
  } else if (s.status === "active") {
    s.deadline = Date.now() + responseTimeLimitMs;
  }
}

function updateResponseTimerDisplay() {
  const s = stakeholders[state.activeStakeholder];
  const el = document.getElementById("response-timer");
  if (!el) return;

  if (!state.timersStarted || s.deadline == null || s.status !== "active") {
    el.hidden = true;
    el.classList.remove("response-timer-urgent");
    return;
  }

  const totalSeconds = Math.max(0, Math.ceil((s.deadline - Date.now()) / 1000));
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  el.textContent = `⏱ ${mm}:${String(ss).padStart(2, "0")}`;
  el.hidden = false;
  el.classList.toggle("response-timer-urgent", totalSeconds <= responseUrgentSeconds());
}

function labelForStakeholder(s) {
  if (s.status === "won") return { text: "Won", cls: "sentiment-won" };
  if (s.status === "lost") return { text: "Lost", cls: "sentiment-lost" };
  if (s.confidence >= 65) return { text: "Supportive", cls: "sentiment-positive" };
  if (s.confidence >= 45) return { text: "Neutral", cls: "sentiment-neutral" };
  return { text: "Wary", cls: "sentiment-wary" };
}

function updateSentimentRow(idx) {
  const row = document.querySelector(`.sentiment-row[data-idx="${idx}"]`);
  if (!row) return; // noScoring stakeholders have no sentiment row
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
  if (s.confidence > rules().loseThreshold) return "Uncertain — the client has doubts";
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

function renderBannerReview(s) {
  const notesEl = document.getElementById("banner-notes");
  const resourcesEl = document.getElementById("banner-resources");
  notesEl.classList.remove("banner-notes-loading");
  resourcesEl.innerHTML = "";

  if (s.review) {
    notesEl.textContent = s.review.headline ? `“${s.review.headline}” — ${s.review.notes}` : s.review.notes;

    (s.review.resources || []).forEach((resource) => {
      const link = document.createElement("a");
      link.className = "banner-resource-link";
      link.href = resource.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `📖 ${resource.title}`;
      link.title = resource.description || "";
      resourcesEl.appendChild(link);
    });
  } else {
    notesEl.textContent = "Assessing this conversation…";
    notesEl.classList.add("banner-notes-loading");
  }
}

function updateComposerAndBanner() {
  const s = stakeholders[state.activeStakeholder];
  const input = document.getElementById("player-input");
  const sendBtn = document.getElementById("btn-send");
  const endCheckinBtn = document.getElementById("btn-end-checkin");
  const banner = document.getElementById("conversation-banner");

  if (s.noScoring) {
    const closed = s.status !== "active";
    input.disabled = closed;
    sendBtn.disabled = closed;
    endCheckinBtn.hidden = closed;

    if (!closed) {
      banner.hidden = true;
      banner.className = "conversation-banner";
      return;
    }

    banner.hidden = false;
    banner.className = "conversation-banner banner-closed";
    document.getElementById("banner-headline").textContent = `Check-in ended — ${s.name}`;
    renderBannerReview(s);
    return;
  }

  endCheckinBtn.hidden = true;

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
    document.getElementById("banner-headline").textContent =
      s.name === state.gameOverStakeholder
        ? `❌ GAME OVER — losing ${s.name} ended the whole engagement. Restart the simulation to try again.`
        : `❌ GAME OVER — losing ${state.gameOverStakeholder} ended the whole engagement, so this conversation is over too. Restart the simulation to try again.`;
    renderBannerReview(s);
    return;
  }

  banner.className = "conversation-banner " + (s.status === "won" ? "banner-won" : "banner-lost");
  document.getElementById("banner-headline").textContent =
    s.status === "won"
      ? `✅ Won — ${s.name} is fully on board. Restart the simulation to play again.`
      : `❌ Lost — ${s.name} has ended the conversation. Restart the simulation to try again.`;
  renderBannerReview(s);
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

// Starts the current scenario afresh — used both when a scenario is first
// picked and when the player restarts or replays it.
function resetRound() {
  state.activeStakeholder = 0;
  state.actionCount = 0;
  state.playerTurns = 0;
  state.firedEvents = [];
  state.roundStatus = "active";
  state.gameOverStakeholder = null;
  // Fresh copies, so runtime state never leaks back into the scenario data.
  stakeholders = state.scenario.stakeholders.map((s) => ({ ...s }));
  state.timersStarted = false;
  stakeholders.forEach(initStakeholderRuntimeState);

  highlightActiveSwitch();
  stakeholders.forEach((_, idx) => updateSentimentRow(idx));

  document.getElementById("status-events").innerHTML = "";
  document.getElementById("status-events-block").hidden = true;

  const log = document.getElementById("action-log");
  log.innerHTML = '<li class="log-empty">No actions taken yet.</li>';

  document.getElementById("btn-view-feedback").hidden = true;
  document.getElementById("feedback-content").hidden = true;
  document.getElementById("feedback-error").hidden = true;
  document.getElementById("feedback-loading").hidden = true;

  show("screen-simulation");
  startAllTimersIfNeeded();
  renderActiveStakeholder();
}

function restartSimulation() {
  resetRound();
  show("screen-simulation");
}

// ---------------------------------------------------------------------------
// Performance reviews — both the quick per-conversation kind (shown the
// moment one stakeholder's conversation ends) and the full end-of-round kind.
// ---------------------------------------------------------------------------

function buildStakeholderSummary(idx) {
  const s = stakeholders[idx];
  const lines = s.transcript.map((m) => {
    if (m.role === "event") return `[EVENT] ${m.text}`;
    return `${m.role === "assistant" ? (m.speaker || s.name) : "Consultant"}: ${m.text}`;
  });

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
}

function buildSessionSummary() {
  return stakeholders.map((_, idx) => buildStakeholderSummary(idx)).join("\n\n");
}

// Fetches a quick qualitative review for ONE just-concluded conversation and
// renders it into that stakeholder's banner (populating it live if the
// player is currently looking at it, or silently caching it on the
// stakeholder object for whenever they switch back).
async function requestConversationReview(idx, outcome) {
  const s = stakeholders[idx];

  if (idx === state.activeStakeholder) {
    const notesEl = document.getElementById("banner-notes");
    notesEl.textContent = "Assessing this conversation…";
    notesEl.classList.add("banner-notes-loading");
  }

  try {
    const response = await fetch("/api/conversation-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId: state.scenario.id,
        stakeholder: s.key,
        outcome,
        transcriptSummary: buildStakeholderSummary(idx),
        mood: s.noScoring ? s.mood : undefined
      })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Request failed");

    s.review = {
      headline: data.headline,
      notes: data.notes,
      // Real objects from the server's fixed, hand-verified catalog — see
      // LEARNING_RESOURCES in server.js. Never raw model output.
      resources: Array.isArray(data.relatedResources) ? data.relatedResources : []
    };
  } catch (err) {
    console.warn(`Conversation review unavailable for ${s.name}:`, err.message || err);
    s.review = { headline: "", notes: "", resources: [] }; // fail silently — the outcome banner itself still shows
  }

  if (idx === state.activeStakeholder) updateComposerAndBanner();
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
      body: JSON.stringify({ scenarioId: state.scenario.id, sessionSummary: buildSessionSummary() })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Request failed");
    }

    document.getElementById("feedback-level").textContent = data.level;
    document.getElementById("feedback-summary").textContent = data.summary;
    document.getElementById("feedback-next-level").textContent = data.nextLevelFocus;
    document.getElementById("feedback-support-notes").textContent = data.psychologicalSafetyNotes;
    const supporter = stakeholders.find((s) => s.noScoring);
    document.getElementById("feedback-support-card").hidden = !supporter;
    if (supporter) {
      document.getElementById("feedback-support-heading").textContent =
        `Supporting ${supporter.name.split(" ")[0]} (Psychological Safety)`;
    }

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

    saveAttempt(data); // fire-and-forget — history is a nice-to-have, never blocks the UI
  } catch (err) {
    console.warn("Performance review unavailable:", err.message || err);
    loading.hidden = true;
    content.hidden = true;
    errorBox.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Local attempt history — saved once per completed round, right after the
// full end-of-round review above succeeds. Read by the "My Progress" screen.
// ---------------------------------------------------------------------------

async function saveAttempt(feedbackData) {
  try {
    const record = {
      scenarioId: state.scenario.id,
      level: feedbackData.level,
      summary: feedbackData.summary,
      strengths: feedbackData.strengths,
      growthAreas: feedbackData.growthAreas,
      nextLevelFocus: feedbackData.nextLevelFocus,
      psychologicalSafetyNotes: feedbackData.psychologicalSafetyNotes,
      stakeholders: stakeholders.map((s) => ({
        key: s.key,
        name: s.name,
        noScoring: !!s.noScoring,
        status: s.status,
        confidence: s.noScoring ? null : s.confidence,
        review: s.review || null
      }))
    };

    await fetch("/api/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record)
    });
  } catch (err) {
    console.warn("Could not save this attempt to history:", err.message || err);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function stakeholderBadge(s) {
  let label;
  let cls = "attempt-badge";

  if (s.noScoring) {
    label = `${s.name} — ${s.status === "closed" ? "Closed" : "Ongoing"}`;
    cls += " attempt-badge-neutral";
  } else {
    const outcomeText = s.status === "won" ? "Won" : s.status === "lost" ? "Lost" : "Incomplete";
    label = `${s.name} — ${outcomeText}${s.confidence != null ? ` (${s.confidence}%)` : ""}`;
    cls += s.status === "won" ? " attempt-badge-won" : s.status === "lost" ? " attempt-badge-lost" : " attempt-badge-neutral";
  }

  return el("span", cls, label);
}

function renderAttemptCard(attempt) {
  const card = el("div", "card attempt-card");

  const header = el("div", "attempt-header");
  header.appendChild(el("span", "attempt-level", attempt.level || "Unrated"));
  // Attempts saved before levels existed were all the original kickoff.
  header.appendChild(el("span", "attempt-scenario", attempt.scenarioTitle || "Kickoff"));
  const date = attempt.timestamp
    ? new Date(attempt.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "";
  header.appendChild(el("span", "attempt-date", date));
  card.appendChild(header);

  if (attempt.summary) card.appendChild(el("p", "attempt-summary", attempt.summary));

  const badgeRow = el("div", "attempt-badges");
  (attempt.stakeholders || []).forEach((s) => badgeRow.appendChild(stakeholderBadge(s)));
  card.appendChild(badgeRow);

  const detailsBtn = el("button", "btn btn-secondary attempt-details-btn", "View Full Feedback");
  const details = el("div", "attempt-details");
  details.hidden = true;

  const addSection = (heading, bodyEl) => {
    details.appendChild(el("h4", null, heading));
    details.appendChild(bodyEl);
  };

  if (attempt.strengths && attempt.strengths.length) {
    const ul = el("ul", "bullet-list");
    attempt.strengths.forEach((item) => ul.appendChild(el("li", null, item)));
    addSection("Strengths", ul);
  }
  if (attempt.growthAreas && attempt.growthAreas.length) {
    const ul = el("ul", "bullet-list");
    attempt.growthAreas.forEach((item) => ul.appendChild(el("li", null, item)));
    addSection("Areas to Improve", ul);
  }
  if (attempt.nextLevelFocus) {
    addSection("To Reach the Next Level", el("p", null, attempt.nextLevelFocus));
  }
  if (attempt.psychologicalSafetyNotes) {
    const supporter = (attempt.stakeholders || []).find((s) => s.noScoring);
    const heading = supporter ? `Supporting ${supporter.name.split(" ")[0]}` : "Supporting a Colleague";
    addSection(`${heading} (Psychological Safety)`, el("p", null, attempt.psychologicalSafetyNotes));
  }

  detailsBtn.addEventListener("click", () => {
    details.hidden = !details.hidden;
    detailsBtn.textContent = details.hidden ? "View Full Feedback" : "Hide Full Feedback";
  });

  card.appendChild(detailsBtn);
  card.appendChild(details);
  return card;
}

async function loadProgress() {
  const container = document.getElementById("progress-list");
  container.innerHTML = "";
  container.appendChild(el("p", "progress-status", "Loading your history…"));

  try {
    const response = await fetch("/api/attempts");
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Request failed");

    container.innerHTML = "";

    if (!data.attempts.length) {
      container.appendChild(
        el("p", "progress-status", "No attempts recorded yet — complete a full round to see it here.")
      );
      return;
    }

    data.attempts
      .slice()
      .reverse() // newest first
      .forEach((attempt) => container.appendChild(renderAttemptCard(attempt)));
  } catch (err) {
    console.warn("Could not load attempt history:", err.message || err);
    container.innerHTML = "";
    container.appendChild(el("p", "progress-status", "Could not load your history right now."));
  }
}
