"use strict";

const ErrorWrapper = require("./ErrorWrapper");

/**
 * RetryWrapper - Handles retries with exponential backoff for transient errors
 * Addresses audit issue: lack of retry logic for transient DB errors
 */
class RetryWrapper {
    /**
     * Create a retry wrapper
     * @param {object} options - Retry options
     */
    constructor(options = {}) {
        this.maxRetries = options.maxRetries || 3;
        this.initialDelay = options.initialDelay || 100; // ms
        this.maxDelay = options.maxDelay || 5000; // ms
        this.backoffFactor = options.backoffFactor || 2;
        this.jitterFactor = options.jitterFactor || 0.1;
        this.logger = options.logger || null;
    }

    /**
     * Execute function with retry logic
     * @param {Function} fn - Async function to execute
     * @param {object} context - Context for error reporting
     * @returns {Promise<*>} Function result
     */
    async execute(fn, context = {}) {
        let lastError = null;
        let attempt = 0;
        
        while (attempt <= this.maxRetries) {
            try {
                // Log retry attempt
                if (attempt > 0 && this.logger) {
                    this.logger(`[RETRY] Attempt ${attempt}/${this.maxRetries}`, context);
                }
                
                return await fn();
            } catch (error) {
                lastError = error;
                attempt++;
                
                // Check if error is retryable
                const isTransient = ErrorWrapper.isTransientError(error);
                
                if (!isTransient || attempt > this.maxRetries) {
                    // Not retryable or max retries reached
                    throw ErrorWrapper.sanitizeError(error, {
                        ...context,
                        operation: "retry",
                        attempts: attempt,
                        isTransient,
                    });
                }
                
                // Calculate delay with exponential backoff and jitter
                const delay = this.calculateDelay(attempt);
                
                if (this.logger) {
                    this.logger(
                        `[RETRY] Transient error, retrying in ${delay}ms`,
                        {
                            ...context,
                            attempt,
                            error: error.message,
                        }
                    );
                }
                
                // Wait before retry
                await this.sleep(delay);
            }
        }
        
        // Should never reach here, but just in case
        throw lastError;
    }

    /**
     * Calculate delay for retry with exponential backoff and jitter
     * @param {number} attempt - Current attempt number (1-based)
     * @returns {number} Delay in milliseconds
     */
    calculateDelay(attempt) {
        // Exponential backoff: initialDelay * (backoffFactor ^ (attempt - 1))
        let delay = this.initialDelay * Math.pow(this.backoffFactor, attempt - 1);
        
        // Cap at maxDelay
        delay = Math.min(delay, this.maxDelay);
        
        // Add jitter to prevent thundering herd
        const jitter = delay * this.jitterFactor * (Math.random() * 2 - 1);
        delay = Math.max(0, delay + jitter);
        
        return Math.floor(delay);
    }

    /**
     * Sleep for specified milliseconds
     * @param {number} ms - Milliseconds to sleep
     * @returns {Promise<void>}
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Create a retryable function wrapper
     * @param {Function} fn - Function to wrap
     * @param {object} context - Context for error reporting
     * @returns {Function} Wrapped function
     */
    wrap(fn, context = {}) {
        return (...args) => this.execute(() => fn(...args), context);
    }

    /**
     * Static helper to retry a function
     * @param {Function} fn - Function to retry
     * @param {object} options - Retry options
     * @param {object} context - Context for error reporting
     * @returns {Promise<*>} Function result
     */
    static async retry(fn, options = {}, context = {}) {
        const wrapper = new RetryWrapper(options);
        return wrapper.execute(fn, context);
    }

    /**
     * Check if an operation should be retried based on error type
     * @param {Error} error - Error to check
     * @param {number} attempt - Current attempt number
     * @param {number} maxRetries - Maximum retries
     * @returns {boolean}
     */
    static shouldRetry(error, attempt, maxRetries) {
        if (attempt >= maxRetries) return false;
        return ErrorWrapper.isTransientError(error);
    }

    /**
     * Execute with timeout and retry
     * @param {Function} fn - Function to execute
     * @param {number} timeoutMs - Timeout in milliseconds
     * @param {object} retryOptions - Retry options
     * @param {object} context - Context for error reporting
     * @returns {Promise<*>}
     */
    static async executeWithTimeout(fn, timeoutMs, retryOptions = {}, context = {}) {
        const wrapper = new RetryWrapper(retryOptions);
        
        return wrapper.execute(async () => {
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Operation timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            });
            
            return Promise.race([fn(), timeoutPromise]);
        }, context);
    }
}

module.exports = RetryWrapper;










