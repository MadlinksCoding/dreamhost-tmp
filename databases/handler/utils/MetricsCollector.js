"use strict";

/**
 * MetricsCollector - Track and emit metrics for schema operations
 * Addresses audit issue: no metrics for schema drift
 */
class MetricsCollector {
    constructor(options = {}) {
        this.enabled = options.enabled !== false;
        this.emitter = options.emitter || null; // CloudWatch, Prometheus, etc.
        this.metrics = {
            tablesCreated: 0,
            columnsAdded: 0,
            indexesCreated: 0,
            gsisCreated: 0,
            validationsPassed: 0,
            validationsFailed: 0,
            errors: 0,
            queriesExecuted: 0,
            totalDuration: 0,
        };
        this.timers = new Map();
    }

    /**
     * Increment a counter metric
     * @param {string} name - Metric name
     * @param {number} value - Value to add (default 1)
     * @param {object} tags - Additional tags
     */
    increment(name, value = 1, tags = {}) {
        if (!this.enabled) return;
        
        if (this.metrics[name] !== undefined) {
            this.metrics[name] += value;
        } else {
            this.metrics[name] = value;
        }
        
        this.emit("increment", { metric: name, value, tags });
    }

    /**
     * Record a gauge metric
     * @param {string} name - Metric name
     * @param {number} value - Gauge value
     * @param {object} tags - Additional tags
     */
    gauge(name, value, tags = {}) {
        if (!this.enabled) return;
        
        this.metrics[name] = value;
        this.emit("gauge", { metric: name, value, tags });
    }

    /**
     * Start a timer
     * @param {string} name - Timer name
     * @returns {Function} Function to call to stop timer
     */
    startTimer(name) {
        if (!this.enabled) return () => 0;
        
        const start = Date.now();
        this.timers.set(name, start);
        
        return (tags = {}) => {
            const duration = Date.now() - start;
            this.timers.delete(name);
            this.recordDuration(name, duration, tags);
            return duration;
        };
    }

    /**
     * Record a duration metric
     * @param {string} name - Metric name
     * @param {number} duration - Duration in milliseconds
     * @param {object} tags - Additional tags
     */
    recordDuration(name, duration, tags = {}) {
        if (!this.enabled) return;
        
        this.metrics.totalDuration += duration;
        this.emit("duration", { metric: name, duration, tags });
    }

    /**
     * Record schema operation metrics
     * @param {string} operation - Operation name (plan, apply, validate)
     * @param {object} result - Operation result
     * @param {number} duration - Duration in milliseconds
     */
    recordSchemaOperation(operation, result, duration) {
        if (!this.enabled) return;
        
        const tags = { operation };
        
        if (operation === "apply") {
            this.increment("schema.operations.apply", 1, tags);
            
            // Count specific changes
            if (result.addsApplied) {
                this.gauge("schema.changes.applied", result.addsApplied, tags);
            }
            
            // Track by engine
            for (const engine of ["scylla", "postgres", "mysql"]) {
                const adds = result.report?.addsToApply?.[engine] || [];
                if (adds.length > 0) {
                    this.increment(`schema.changes.${engine}`, adds.length, tags);
                }
            }
        } else if (operation === "validate") {
            const success = !result.errors || result.errors.length === 0;
            this.increment(
                success ? "schema.validations.passed" : "schema.validations.failed",
                1,
                tags
            );
            
            if (result.errors) {
                this.gauge("schema.validation.errors", result.errors.length, tags);
            }
        }
        
        this.recordDuration(`schema.operation.${operation}`, duration, tags);
    }

    /**
     * Record database query metrics
     * @param {string} engine - Database engine
     * @param {string} operation - Operation type
     * @param {number} duration - Duration in milliseconds
     * @param {boolean} success - Whether query succeeded
     */
    recordQuery(engine, operation, duration, success = true) {
        if (!this.enabled) return;
        
        const tags = { engine, operation };
        
        this.increment("queries.executed", 1, tags);
        this.increment(
            success ? "queries.success" : "queries.error",
            1,
            tags
        );
        this.recordDuration("query.duration", duration, tags);
    }

    /**
     * Record error
     * @param {string} type - Error type
     * @param {object} error - Error object
     * @param {object} context - Error context
     */
    recordError(type, error, context = {}) {
        if (!this.enabled) return;
        
        this.increment("errors", 1, { type, ...context });
        this.emit("error", {
            type,
            message: error.message,
            code: error.code,
            context,
        });
    }

    /**
     * Record lifecycle metrics
     * @param {object} lifecycle - Lifecycle data
     */
    recordLifecycle(lifecycle) {
        if (!this.enabled) return;
        
        for (const engine of ["scylla", "postgres", "mysql"]) {
            const data = lifecycle[engine] || {};
            
            if (data.active) {
                this.gauge(`lifecycle.${engine}.active`, data.active.length);
            }
            if (data.future) {
                this.gauge(`lifecycle.${engine}.future`, data.future.length);
            }
            if (data.removed) {
                this.gauge(`lifecycle.${engine}.removed`, data.removed.length);
            }
        }
    }

    /**
     * Emit metric to external system
     * @param {string} type - Metric type
     * @param {object} data - Metric data
     */
    emit(type, data) {
        if (!this.enabled || !this.emitter) return;
        
        try {
            this.emitter(type, {
                ...data,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            // Don't let metrics collection break the app
            console.error("Failed to emit metric:", error);
        }
    }

    /**
     * Get all collected metrics
     * @returns {object} Metrics object
     */
    getMetrics() {
        return { ...this.metrics };
    }

    /**
     * Get metrics summary
     * @returns {object} Summary
     */
    getSummary() {
        return {
            totalChanges: 
                this.metrics.tablesCreated +
                this.metrics.columnsAdded +
                this.metrics.indexesCreated +
                this.metrics.gsisCreated,
            validations: {
                passed: this.metrics.validationsPassed,
                failed: this.metrics.validationsFailed,
            },
            errors: this.metrics.errors,
            queries: this.metrics.queriesExecuted,
            avgQueryDuration: this.metrics.queriesExecuted > 0
                ? this.metrics.totalDuration / this.metrics.queriesExecuted
                : 0,
        };
    }

    /**
     * Reset metrics
     */
    reset() {
        for (const key of Object.keys(this.metrics)) {
            this.metrics[key] = 0;
        }
        this.timers.clear();
    }

    /**
     * Create CloudWatch emitter
     * @param {object} cloudwatch - AWS CloudWatch client
     * @param {string} namespace - CloudWatch namespace
     * @returns {Function} Emitter function
     */
    static createCloudWatchEmitter(cloudwatch, namespace) {
        return async (type, data) => {
            const metricData = {
                MetricName: data.metric,
                Value: data.value || data.duration || 1,
                Unit: type === "duration" ? "Milliseconds" : "Count",
                Timestamp: new Date(),
                Dimensions: Object.entries(data.tags || {}).map(([Name, Value]) => ({
                    Name,
                    Value: String(Value),
                })),
            };
            
            try {
                await cloudwatch.putMetricData({
                    Namespace: namespace,
                    MetricData: [metricData],
                }).promise();
            } catch (error) {
                console.error("Failed to send CloudWatch metric:", error);
            }
        };
    }

    /**
     * Create console emitter for debugging
     * @returns {Function} Emitter function
     */
    static createConsoleEmitter() {
        return (type, data) => {
            console.log(`[METRIC:${type}]`, JSON.stringify(data));
        };
    }
}

module.exports = MetricsCollector;










