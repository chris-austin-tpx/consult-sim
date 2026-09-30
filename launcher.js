// ConsultSim — "Fire the ball" response-time launcher: the pure maths.
//
// On the Stakeholders screen the player presses and holds a pinball-style
// plunger at the left end of a line. The longer they hold, the further the
// ball goes, and where it stops sets how long they get to answer each
// stakeholder message. Hold too long and the ball flies off the end of the
// line — "out of scope" — leaving them with almost no time at all.
//
// This file has no DOM code so it can be unit-tested (launcher.test.js). It
// works both as a browser global (window.Launcher) and a CommonJS module.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Launcher = api;
})(typeof self !== "undefined" ? self : this, function () {
  const LAUNCHER_CONFIG = {
    FULL_CHARGE_MS: 1600,    // holding this long lands the ball exactly at the end of the line
    MIN_SECONDS: 15,         // ball barely moves
    MAX_SECONDS: 180,        // ball stops right at the edge
    OVERSHOOT_SECONDS: 10,   // ball falls off the end — greed is punished
    MAX_SHOTS: 3,            // like SOW revisions: three, then you live with it
    JITTER: 0.04             // a little "market volatility" so it's not perfectly repeatable
  };

  // Named zones along the line, left to right. `until` is the distance
  // fraction (0–1) where each zone ends.
  const ZONES = [
    { id: "elevator", until: 0.2, label: "Elevator Pitch", quip: "Short, punchy, terrifying." },
    { id: "sync", until: 0.45, label: "Quick Sync", quip: "Enough time to say 'great question'." },
    { id: "takeaway", until: 0.7, label: "Let Me Take That Away", quip: "Room to think. Or to look like you are." },
    { id: "circleback", until: 0.9, label: "Circle Back Territory", quip: "Leisurely. The client has noticed." },
    { id: "billable", until: 1.0000001, label: "Fully Billable", quip: "Maximum thinking time. Charged in 6-minute increments." }
  ];
  const OVERSHOOT_ZONE = {
    id: "overshoot",
    label: "Out of Scope",
    quip: "You overcommitted. The ball is gone, and so is your thinking time."
  };

  function holdToDistance(holdMs, jitter = 0) {
    const base = Math.max(0, holdMs) / LAUNCHER_CONFIG.FULL_CHARGE_MS;
    return Math.max(0, base + jitter);
  }

  function distanceToSeconds(distance) {
    if (distance > 1) return LAUNCHER_CONFIG.OVERSHOOT_SECONDS;
    const { MIN_SECONDS, MAX_SECONDS } = LAUNCHER_CONFIG;
    const d = Math.max(0, distance);
    const raw = MIN_SECONDS + d * (MAX_SECONDS - MIN_SECONDS);
    return Math.round(raw / 5) * 5;
  }

  function zoneFor(distance) {
    if (distance > 1) return OVERSHOOT_ZONE;
    return ZONES.find((z) => distance < z.until) || ZONES[ZONES.length - 1];
  }

  function launchResult(holdMs, jitter = 0) {
    const distance = holdToDistance(holdMs, jitter);
    return {
      distance,
      overshot: distance > 1,
      seconds: distanceToSeconds(distance),
      zone: zoneFor(distance)
    };
  }

  return { LAUNCHER_CONFIG, ZONES, OVERSHOOT_ZONE, holdToDistance, distanceToSeconds, zoneFor, launchResult };
});
