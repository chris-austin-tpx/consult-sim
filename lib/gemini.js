// Gemini bits shared by server.js and scripts/draft-scenario.js.

const MODEL = "gemini-3.5-flash-lite";

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

module.exports = { MODEL, withTimeout, isOverloaded };
