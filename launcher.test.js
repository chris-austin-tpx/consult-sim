// Unit tests for the pure maths behind the "fire a ball to pick your
// response time" launcher. The DOM/animation side lives in script.js and is
// checked manually in the browser; this covers the bits that decide what
// time the player actually ends up with.
const {
  LAUNCHER_CONFIG,
  holdToDistance,
  distanceToSeconds,
  zoneFor,
  launchResult
} = require("./launcher");

const { FULL_CHARGE_MS, MIN_SECONDS, MAX_SECONDS, OVERSHOOT_SECONDS } = LAUNCHER_CONFIG;

describe("holdToDistance", () => {
  test("a longer press sends the ball further", () => {
    expect(holdToDistance(800)).toBeGreaterThan(holdToDistance(200));
  });

  test("a zero or negative press goes nowhere", () => {
    expect(holdToDistance(0)).toBe(0);
    expect(holdToDistance(-50)).toBe(0);
  });

  test("holding for exactly the full-charge time reaches the end of the line", () => {
    expect(holdToDistance(FULL_CHARGE_MS)).toBeCloseTo(1, 5);
  });

  test("holding past full charge overshoots the end of the line", () => {
    expect(holdToDistance(FULL_CHARGE_MS * 1.5)).toBeGreaterThan(1);
  });

  test("jitter nudges the distance but never below zero", () => {
    expect(holdToDistance(800, 0.05)).toBeCloseTo(holdToDistance(800) + 0.05, 5);
    expect(holdToDistance(0, -0.2)).toBe(0);
  });
});

describe("distanceToSeconds", () => {
  test("the start of the line gives the minimum time", () => {
    expect(distanceToSeconds(0)).toBe(MIN_SECONDS);
  });

  test("the very end of the line gives the maximum time", () => {
    expect(distanceToSeconds(1)).toBe(MAX_SECONDS);
  });

  test("going off the end gives the tiny overshoot penalty time", () => {
    expect(distanceToSeconds(1.01)).toBe(OVERSHOOT_SECONDS);
    expect(OVERSHOOT_SECONDS).toBeLessThan(MIN_SECONDS);
  });

  test("results are rounded to the nearest 5 seconds", () => {
    for (let d = 0; d <= 1; d += 0.037) {
      expect(distanceToSeconds(d) % 5).toBe(0);
    }
  });

  test("further along always means at least as much time", () => {
    let prev = -1;
    for (let d = 0; d <= 1; d += 0.01) {
      const s = distanceToSeconds(d);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
});

describe("zoneFor", () => {
  test("every on-line distance has a named zone", () => {
    for (let d = 0; d <= 1; d += 0.05) {
      expect(typeof zoneFor(d).label).toBe("string");
    }
  });

  test("overshooting lands in the out-of-scope zone", () => {
    expect(zoneFor(1.2).id).toBe("overshoot");
  });
});

describe("launchResult", () => {
  test("bundles distance, seconds, zone and overshoot flag", () => {
    const r = launchResult(FULL_CHARGE_MS / 2);
    expect(r.overshot).toBe(false);
    expect(r.distance).toBeCloseTo(0.5, 5);
    expect(r.seconds).toBe(distanceToSeconds(0.5));
    expect(r.zone).toEqual(zoneFor(0.5));
  });

  test("flags an overshoot", () => {
    const r = launchResult(FULL_CHARGE_MS * 2);
    expect(r.overshot).toBe(true);
    expect(r.seconds).toBe(OVERSHOOT_SECONDS);
  });
});
