
"use strict";

// Import utility modules

// import { createRequire } from 'module';
// const require = createRequire(import.meta.url);

const EnvLoader = require('./EnvLoader');


// Load env once at startup; throws on failure
let ENV;
try {
    ENV = EnvLoader.loadEnv();
    // Override process.env with ENV values
    if (ENV && typeof ENV === 'object') {
        for (const [key, value] of Object.entries(ENV)) {
            process.env[key] = value;
        }
    }
} catch (err) {
  throw new Error('Failed to load ENV: ' + (err?.message || err));
}
const ErrorHandler = require('./ErrorHandler');
const ConfigFileLoader = require('./ConfigFileLoader');
const DateTime = require('./DateTime');
const Logger = require('./Logger');
const SafeUtils = require('./SafeUtils');

// Define aliases
const ValidationError = ErrorHandler.ValidationError;
const NotFoundError = ErrorHandler.NotFoundError;
const ConflictError = ErrorHandler.ConflictError;
const StateTransitionError = ErrorHandler.StateTransitionError;

// Export all utility modules for centralized importing
module.exports = {
  ENV,
  ConfigFileLoader,
  DateTime,
  EnvLoader,
  ErrorHandler,
  Logger,
  SafeUtils,
  ValidationError,
  NotFoundError,
  ConflictError,
  StateTransitionError,
};
