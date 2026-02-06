"use strict";

/**
 * SchemaDiffer - Compare current vs desired schema state
 * Addresses audit issue: no schema diffing logic
 */
class SchemaDiffer {
    /**
     * Compare two schemas
     * @param {object} current - Current schema state
     * @param {object} desired - Desired schema state
     * @param {object} options - Diff options
     * @returns {object} Diff result
     */
    static diff(current, desired, options = {}) {
        const { engine, tableName } = options;
        
        const changes = {
            additions: [],
            modifications: [],
            deletions: [],
            warnings: [],
        };
        
        if (engine === "postgres" || engine === "mysql") {
            this.diffRelational(current, desired, changes, options);
        } else if (engine === "scylla") {
            this.diffScylla(current, desired, changes, options);
        }
        
        return changes;
    }

    /**
     * Diff relational database schema (PostgreSQL/MySQL)
     * @param {object} current - Current schema
     * @param {object} desired - Desired schema
     * @param {object} changes - Changes object to populate
     * @param {object} options - Options
     */
    static diffRelational(current, desired, changes, options) {
        const { tableName } = options;
        
        // Diff columns
        const currentColumns = current.columns || {};
        const desiredColumns = desired.columns || {};
        
        // Find added columns
        for (const [colName, colSpec] of Object.entries(desiredColumns)) {
            if (!currentColumns[colName]) {
                changes.additions.push({
                    type: "column",
                    table: tableName,
                    column: colName,
                    spec: colSpec,
                });
            } else {
                // Check for modifications
                const currentSpec = currentColumns[colName];
                const modifications = this.diffColumnSpec(currentSpec, colSpec, colName, tableName);
                changes.modifications.push(...modifications);
            }
        }
        
        // Find deleted columns
        for (const colName of Object.keys(currentColumns)) {
            if (!desiredColumns[colName]) {
                changes.deletions.push({
                    type: "column",
                    table: tableName,
                    column: colName,
                });
                changes.warnings.push(
                    `Column ${tableName}.${colName} exists but not in desired schema (manual removal required)`
                );
            }
        }
        
        // Diff indexes
        const currentIndexes = current.indexes || [];
        const desiredIndexes = desired.indexes || [];
        
        const currentIndexNames = new Set(currentIndexes.map(idx => idx.name));
        const desiredIndexNames = new Set(desiredIndexes.map(idx => idx.name));
        
        // Find added indexes
        for (const idx of desiredIndexes) {
            if (!currentIndexNames.has(idx.name)) {
                changes.additions.push({
                    type: "index",
                    table: tableName,
                    index: idx.name,
                    spec: idx,
                });
            }
        }
        
        // Find deleted indexes
        for (const idx of currentIndexes) {
            if (!desiredIndexNames.has(idx.name)) {
                changes.deletions.push({
                    type: "index",
                    table: tableName,
                    index: idx.name,
                });
                changes.warnings.push(
                    `Index ${idx.name} on ${tableName} exists but not in desired schema (manual removal required)`
                );
            }
        }
    }

    /**
     * Diff Scylla/DynamoDB schema
     * @param {object} current - Current schema
     * @param {object} desired - Desired schema
     * @param {object} changes - Changes object to populate
     * @param {object} options - Options
     */
    static diffScylla(current, desired, changes, options) {
        const { tableName } = options;
        
        // Diff GSIs
        const currentGSIs = current.GlobalSecondaryIndexes || [];
        const desiredGSIs = desired.GlobalSecondaryIndexes || [];
        
        const currentGSINames = new Set(currentGSIs.map(gsi => gsi.IndexName));
        const desiredGSINames = new Set(desiredGSIs.map(gsi => gsi.IndexName));
        
        // Find added GSIs
        for (const gsi of desiredGSIs) {
            if (!currentGSINames.has(gsi.IndexName)) {
                changes.additions.push({
                    type: "gsi",
                    table: tableName,
                    index: gsi.IndexName,
                    spec: gsi,
                });
            }
        }
        
        // Find deleted GSIs
        for (const gsi of currentGSIs) {
            if (!desiredGSINames.has(gsi.IndexName)) {
                changes.deletions.push({
                    type: "gsi",
                    table: tableName,
                    index: gsi.IndexName,
                });
                changes.warnings.push(
                    `GSI ${gsi.IndexName} on ${tableName} exists but not in desired schema (manual removal required)`
                );
            }
        }
        
        // Check for key schema changes (not supported)
        if (current.PK !== desired.PK || current.SK !== desired.SK) {
            changes.warnings.push(
                `Key schema change detected for ${tableName} (not supported - requires table recreation)`
            );
        }
    }

    /**
     * Diff column specifications
     * @param {object} current - Current column spec
     * @param {object} desired - Desired column spec
     * @param {string} colName - Column name
     * @param {string} tableName - Table name
     * @returns {Array} List of modifications
     */
    static diffColumnSpec(current, desired, colName, tableName) {
        const modifications = [];
        
        // Type change
        if (current.type !== desired.type) {
            modifications.push({
                type: "column_type_change",
                table: tableName,
                column: colName,
                from: current.type,
                to: desired.type,
                warning: "Type changes may require data migration",
            });
        }
        
        // NULL constraint change
        if (current.notNull !== desired.notNull) {
            modifications.push({
                type: "column_null_constraint_change",
                table: tableName,
                column: colName,
                from: current.notNull,
                to: desired.notNull,
                warning: "NULL constraint changes may fail if data violates constraint",
            });
        }
        
        // Default value change
        if (current.default !== desired.default) {
            modifications.push({
                type: "column_default_change",
                table: tableName,
                column: colName,
                from: current.default,
                to: desired.default,
            });
        }
        
        return modifications;
    }

    /**
     * Generate SQL statements for changes
     * @param {object} changes - Diff changes
     * @param {string} engine - Database engine
     * @returns {Array<string>} SQL statements
     */
    static generateSQL(changes, engine) {
        const statements = [];
        
        for (const change of changes.additions) {
            if (change.type === "column") {
                // This would need to be generated based on engine
                statements.push(`-- Add column: ${change.table}.${change.column}`);
            } else if (change.type === "index") {
                statements.push(`-- Create index: ${change.index} on ${change.table}`);
            }
        }
        
        for (const change of changes.modifications) {
            statements.push(`-- Modify: ${change.type} ${change.table}.${change.column || ""}`);
        }
        
        for (const change of changes.deletions) {
            statements.push(`-- Delete: ${change.type} ${change.table}.${change.column || change.index || ""}`);
        }
        
        return statements;
    }

    /**
     * Check if changes are safe (additive only)
     * @param {object} changes - Diff changes
     * @returns {boolean} True if all changes are safe
     */
    static isSafe(changes) {
        // Only additions are considered safe
        return changes.modifications.length === 0 && changes.deletions.length === 0;
    }

    /**
     * Get summary of changes
     * @param {object} changes - Diff changes
     * @returns {object} Summary
     */
    static getSummary(changes) {
        return {
            additions: changes.additions.length,
            modifications: changes.modifications.length,
            deletions: changes.deletions.length,
            warnings: changes.warnings.length,
            safe: this.isSafe(changes),
        };
    }
}

module.exports = SchemaDiffer;










