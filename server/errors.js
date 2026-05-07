/**
 * Structured error system: every API failure returns
 *   { error, reason, solution, code? }
 *
 * - `error`    : short user-facing message (Hinglish OK)
 * - `reason`   : why it failed (technical/contextual)
 * - `solution` : actionable next step for the user
 * - `code`     : stable machine-readable identifier (snake_case)
 *
 * Use:
 *   throw new AppError("Punch save nahi hua", { reason: "...", solution: "...", status: 400, code: "punch_failed" });
 *   sendError(res, 400, "Punch save nahi hua", { reason, solution, code });
 */

class AppError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "AppError";
    this.status = opts.status || 400;
    this.reason = opts.reason || "";
    this.solution = opts.solution || "";
    this.code = opts.code || "app_error";
  }
}

function sendError(res, status, message, extra = {}) {
  return res.status(status).json({
    error: message,
    reason: extra.reason || "",
    solution: extra.solution || "",
    code: extra.code || "error",
  });
}

/** Express error-handling middleware. Mount LAST. */
function errorMiddleware(err, req, res, _next) {
  // Log everything — keep noisy logs only in non-prod for known 4xx.
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error("[error]", req.method, req.path, "→", err.message, err.stack);
  }
  // Friendly defaults for common buckets
  let reason = err.reason || "";
  let solution = err.solution || "";
  let code = err.code || "internal_error";
  if (status === 401) {
    reason = reason || "Aapka session expire ho gaya hai ya valid token nahi mila.";
    solution = solution || "Dobara login karo aur retry karo.";
    code = code === "internal_error" ? "unauthorized" : code;
  } else if (status === 403) {
    reason = reason || "Is action ke liye aapke role me permission nahi hai.";
    solution = solution || "Apne admin se permission request karo.";
    code = code === "internal_error" ? "forbidden" : code;
  } else if (status === 404) {
    reason = reason || "Jo record/page chahiye wo system me nahi mila.";
    solution = solution || "URL ya ID dobara check karo.";
    code = code === "internal_error" ? "not_found" : code;
  } else if (status === 409) {
    reason = reason || "Same data ya state pehle se exist karta hai.";
    solution = solution || "Pehle wali entry refresh karo ya different value try karo.";
    code = code === "internal_error" ? "conflict" : code;
  } else if (status === 429) {
    reason = reason || "Bahut tezi se requests aayi.";
    solution = solution || "Kuch second ruko, fir try karo.";
    code = code === "internal_error" ? "rate_limited" : code;
  } else if (status >= 500) {
    reason = reason || "Server me unexpected error aa gayi.";
    solution = solution || "1 minute me retry karo. Problem rahe to admin ko bataao.";
    code = code === "internal_error" ? "server_error" : code;
  }
  res.status(status).json({
    error: err.message || "Server error",
    reason,
    solution,
    code,
  });
}

/** Wrap async route handlers so thrown errors flow into errorMiddleware. */
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { AppError, sendError, errorMiddleware, wrap };
