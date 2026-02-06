"use strict";

const EnvLoader = require("./utils/EnvLoader");
const ErrorHandler = require("./utils/ErrorHandler");

// Load env once at startup; throws on failure
let ENV;
try {
  ENV = EnvLoader.loadEnv();
} catch (err) {
  ErrorHandler.addError("Failed to load environment at startup", {
    code: "ENV_LOAD_FAILED",
    origin: "index",
    error: err?.message || "unknown",
  });
  throw err;
}

// Export the validated environment for consumers
module.exports = ENV;
