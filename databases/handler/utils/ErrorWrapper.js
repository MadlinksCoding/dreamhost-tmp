"use strict";

/**
 * ErrorWrapper - Standardized error handling and sanitization
 * Addresses audit issues: no error handling in rawRequest, raw error propagation
 */
class ErrorWrapper {
    /**
     * Wrap a function with try-catch error handling
     * @param {Function} fn - Async function to wrap
     * @param {object} context - Context information for error messages
     * @returns {Promise<*>} Result or null on error
     */
    static async safe(fn, context = {}) {
        try {
            return await fn();
        } catch (error) {
            // For safe(), we want to return null, not rethrow
            return this.handleError(error, { ...context, rethrow: false });
        }
    }

    /**
     * Handle and sanitize errors
     * @param {Error} error - Error to handle
     * @param {object} context - Context information
     * @returns {null}
     * @throws {Error} Sanitized error with context
     */
    static handleError(error, context = {}) {
        const sanitized = this.sanitizeError(error, context);
        
        // Log error for debugging
        if (context.logger) {
            context.logger("[ERROR]", {
                message: sanitized.message,
                context: sanitized.context,
                stack: context.includeStack ? sanitized.stack : undefined,
            });
        }
        
        // Rethrow if specified
        if (context.rethrow !== false) {
            throw sanitized;
        }
        
        return null;
    }

    /**
     * Sanitize error by removing sensitive information
     * @param {Error} error - Error to sanitize
     * @param {object} context - Context information
     * @returns {Error} Sanitized error
     */
    static sanitizeError(error, context = {}) {
        // Create a new error with sanitized message
        const sanitized = new Error();
        
        // Build context-aware error message
        const parts = [];
        
        if (context.operation) parts.push(`[${context.operation}]`);
        if (context.engine) parts.push(`[${context.engine}]`);
        if (context.table) parts.push(`table:${context.table}`);
        if (context.column) parts.push(`column:${context.column}`);
        if (context.index) parts.push(`index:${context.index}`);
        
        // Add sanitized error message
        const errorMsg = this.sanitizeMessage(error?.message || String(error));
        parts.push(errorMsg);
        
        sanitized.message = parts.join(" ");
        
        // Add context as property
        sanitized.context = {
            ...context,
            originalError: error?.constructor?.name,
        };
        
        // Preserve stack trace if available
        if (error?.stack) {
            sanitized.stack = this.sanitizeStack(error.stack);
        }
        
        // Preserve error code if available
        if (error?.code) {
            sanitized.code = error.code;
        }
        
        return sanitized;
    }

    /**
     * Sanitize error message by removing sensitive data
     * @param {string} message - Error message
     * @returns {string} Sanitized message
     */
    static sanitizeMessage(message) {
        if (typeof message !== "string") return "Unknown error";
        
        // Remove potential credentials
        let sanitized = message
            .replace(/password[=:]\s*["']?[^"'\s]+["']?/gi, "password=***")
            .replace(/secret[=:]\s*["']?[^"'\s]+["']?/gi, "secret=***")
            .replace(/token[=:]\s*["']?[^"'\s]+["']?/gi, "token=***")
            .replace(/key[=:]\s*["']?[^"'\s]+["']?/gi, "key=***");
        
        // Truncate if too long
        if (sanitized.length > 500) {
            sanitized = sanitized.substring(0, 500) + "... (truncated)";
        }
        
        return sanitized;
    }

    /**
     * Sanitize stack trace
     * @param {string} stack - Stack trace
     * @returns {string} Sanitized stack trace
     */
    static sanitizeStack(stack) {
        if (typeof stack !== "string") return "";
        
        // Remove absolute paths and keep only relative paths
        return stack
            .split("\n")
            .map(line => {
                // Remove full file paths, keep only filename
                return line.replace(/\([^)]*[\/\\]([^\/\\]+:\d+:\d+)\)/g, "($1)");
            })
            .slice(0, 10) // Limit stack trace length
            .join("\n");
    }

    /**
     * Wrap database query with error handling
     * @param {Function} queryFn - Query function to execute
     * @param {object} context - Context for error reporting
     * @returns {Promise<*>} Query result
     */
    static async wrapQuery(queryFn, context = {}) {
        try {
            return await queryFn();
        } catch (error) {
            // Check if it's a transient error that could be retried
            const isTransient = this.isTransientError(error);
            
            const sanitized = this.sanitizeError(error, {
                ...context,
                isTransient,
            });
            
            throw sanitized;
        }
    }

    /**
     * Check if error is transient (retryable)
     * @param {Error} error - Error to check
     * @returns {boolean}
     */
    static isTransientError(error) {
        if (!error) return false;
        
        const transientCodes = new Set([
            "ECONNRESET",
            "ETIMEDOUT",
            "ECONNREFUSED",
            "EPIPE",
            "ER_LOCK_WAIT_TIMEOUT",
            "ER_LOCK_DEADLOCK",
            "PROTOCOL_CONNECTION_LOST",
        ]);
        
        if (error.code && transientCodes.has(error.code)) return true;
        
        const message = String(error.message || "").toLowerCase();
        const transientPatterns = [
            "connection",
            "timeout",
            "deadlock",
            "lock wait",
            "too many connections",
            "connection refused",
        ];
        
        return transientPatterns.some(pattern => message.includes(pattern));
    }

    /**
     * Create a context-aware error
     * @param {string} message - Error message
     * @param {object} context - Context information
     * @returns {Error}
     */
    static createError(message, context = {}) {
        const error = new Error(message);
        error.context = context;
        return error;
    }

    /**
     * Validate error context
     * @param {object} context - Context to validate
     * @throws {Error} If context is invalid
     */
    static validateContext(context) {
        if (context && typeof context !== "object") {
            throw new Error("Error context must be an object");
        }
        
        const validKeys = new Set([
            "operation", "engine", "table", "column", "index",
            "logger", "rethrow", "includeStack", "isTransient",
        ]);
        
        for (const key of Object.keys(context || {})) {
            if (!validKeys.has(key)) {
                console.warn(`Unknown context key: ${key}`);
            }
        }
    }
}

module.exports = ErrorWrapper;

