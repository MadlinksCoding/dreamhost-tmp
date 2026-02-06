"use strict";

/**
 * StructuredLogger - Emit structured JSON logs with telemetry support
 * Addresses audit issue: no telemetry or audit logging
 */
class StructuredLogger {
    /**
     * Create a structured logger
     * @param {object} options - Logger options
     */
    constructor(options = {}) {
        this.serviceName = options.serviceName || "database-schema-handler";
        this.environment = options.environment || process.env.NODE_ENV || "development";
        this.version = options.version || "1.0.0";
        this.minLevel = options.minLevel || "info";
        this.outputStream = options.outputStream || process.stdout;
        this.errorStream = options.errorStream || process.stderr;
        this.telemetryEnabled = options.telemetryEnabled !== false;
        this.telemetryCallback = options.telemetryCallback || null;
        
        // Log levels
        this.levels = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3,
        };
    }

    /**
     * Log a message with context
     * @param {string} level - Log level
     * @param {string} message - Log message
     * @param {object} context - Additional context
     */
    log(level, message, context = {}) {
        // Check if level should be logged
        if (this.levels[level] < this.levels[this.minLevel]) {
            return;
        }
        
        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            service: this.serviceName,
            environment: this.environment,
            version: this.version,
            message,
            ...context,
        };
        
        // Add trace ID if available
        if (context.traceId || this.traceId) {
            logEntry.traceId = context.traceId || this.traceId;
        }
        
        // Emit to appropriate stream
        const stream = level === "error" ? this.errorStream : this.outputStream;
        stream.write(JSON.stringify(logEntry) + "\n");
        
        // Send to telemetry if enabled
        if (this.telemetryEnabled && this.telemetryCallback) {
            this.telemetryCallback(logEntry);
        }
    }

    /**
     * Log debug message
     * @param {string} message - Log message
     * @param {object} context - Additional context
     */
    debug(message, context = {}) {
        this.log("debug", message, context);
    }

    /**
     * Log info message
     * @param {string} message - Log message
     * @param {object} context - Additional context
     */
    info(message, context = {}) {
        this.log("info", message, context);
    }

    /**
     * Log warning message
     * @param {string} message - Log message
     * @param {object} context - Additional context
     */
    warn(message, context = {}) {
        this.log("warn", message, context);
    }

    /**
     * Log error message
     * @param {string} message - Log message
     * @param {object} context - Additional context
     */
    error(message, context = {}) {
        this.log("error", message, {
            ...context,
            stack: context.error?.stack,
        });
    }

    /**
     * Log schema operation
     * @param {string} operation - Operation type (plan, apply, validate)
     * @param {string} engine - Database engine
     * @param {object} details - Operation details
     */
    logSchemaOperation(operation, engine, details = {}) {
        this.info(`Schema ${operation}`, {
            operation,
            engine,
            ...details,
            category: "schema",
        });
    }

    /**
     * Log database query
     * @param {string} engine - Database engine
     * @param {string} operation - Operation type
     * @param {object} details - Query details
     */
    logQuery(engine, operation, details = {}) {
        this.debug(`Database query`, {
            engine,
            operation,
            ...details,
            category: "query",
        });
    }

    /**
     * Log lifecycle event
     * @param {string} item - Item type (table, column, index)
     * @param {string} action - Action (add, skip, remove)
     * @param {object} details - Event details
     */
    logLifecycle(item, action, details = {}) {
        this.info(`Lifecycle ${action}`, {
            item,
            action,
            ...details,
            category: "lifecycle",
        });
    }

    /**
     * Log validation result
     * @param {boolean} success - Whether validation succeeded
     * @param {object} details - Validation details
     */
    logValidation(success, details = {}) {
        const level = success ? "info" : "error";
        this.log(level, `Validation ${success ? "passed" : "failed"}`, {
            success,
            ...details,
            category: "validation",
        });
    }

    /**
     * Start a timer for operation
     * @param {string} operation - Operation name
     * @returns {Function} Function to call to end timer
     */
    startTimer(operation) {
        const start = Date.now();
        return (context = {}) => {
            const duration = Date.now() - start;
            this.info(`${operation} completed`, {
                operation,
                duration,
                ...context,
                category: "performance",
            });
            return duration;
        };
    }

    /**
     * Create a child logger with additional context
     * @param {object} context - Additional context for child logger
     * @returns {StructuredLogger}
     */
    child(context = {}) {
        const childLogger = new StructuredLogger({
            serviceName: this.serviceName,
            environment: this.environment,
            version: this.version,
            minLevel: this.minLevel,
            outputStream: this.outputStream,
            errorStream: this.errorStream,
            telemetryEnabled: this.telemetryEnabled,
            telemetryCallback: this.telemetryCallback,
        });
        
        // Override log method to include context
        const originalLog = childLogger.log.bind(childLogger);
        childLogger.log = (level, message, additionalContext = {}) => {
            originalLog(level, message, { ...context, ...additionalContext });
        };
        
        return childLogger;
    }

    /**
     * Set trace ID for request tracking
     * @param {string} traceId - Trace ID
     */
    setTraceId(traceId) {
        this.traceId = traceId;
    }

    /**
     * Emit audit log entry
     * @param {string} action - Action performed
     * @param {object} details - Audit details
     */
    audit(action, details = {}) {
        this.log("info", `Audit: ${action}`, {
            action,
            ...details,
            category: "audit",
            auditLog: true,
        });
    }

    /**
     * Create a simple console-compatible logger
     * @returns {object} Console-compatible logger
     */
    static createConsoleLogger() {
        return {
            log: (...args) => console.log(...args),
            info: (...args) => console.info(...args),
            warn: (...args) => console.warn(...args),
            error: (...args) => console.error(...args),
            debug: (...args) => console.debug(...args),
        };
    }
}

module.exports = StructuredLogger;










