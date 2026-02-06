const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs').promises;
const { pathToFileURL } = require('url');
const CircuitBreaker = require('opossum');
const { default: pLimit } = require('p-limit');

/**
 * ScyllaDb - Node.js client for ScyllaDB with Alternator endpoint
 * Provides DynamoDB-compatible operations with high performance
 */
class Scylla {
    /* ---------- CONFIGURABLE DEFAULTS ---------- */
    static DEFAULT_RETRIES = 3;
    static INITIAL_BACKOFF_MS = 100;
    static DEFAULT_PORT = 8000;
    static CONTENT_TYPE = 'application/x-amz-json-1.0';

    /* ---------- PRIVATE IN-MEMORY STATE ---------- */
    static #errors = [];
    static #tableConfigs = {};
    static #cache = { getItem: {}, scan: {}, describe: {} };
    static #persistentAgent = null; // Will be initialized based on protocol
    static #customRequestOptions = {};
    static #limiter = null; // p-limit instance when enabled
    static #breaker = null; // global breaker instance
    static #operationBreakers = {}; // per-operation breakers when enabled

    /* ---------- RUNTIME CONFIG ---------- */
    /**
     * Runtime configuration for Scylla Alternator client.
     *
     * Sections:
     * - endpoint/port/retries/backoff: transport + retry behavior.
     * - circuitBreaker: opossum breaker settings; control fail-fast behavior.
     * - concurrency: p-limit settings; cap in-flight requests and queue size.
     * - cacheBypass: allow skipping guards when serving cache hits (no network).
     * - breakerMode: choose one global breaker or per-operation breakers.
     * - queuePolicy: define behavior when the waiting queue is saturated.
     */
    static #config = {
        endpoint: process.env.SCYLLA_ALTERNATOR_ENDPOINT ?? 'http://localhost:8000/',
        port: Scylla.DEFAULT_PORT,
        retries: Scylla.DEFAULT_RETRIES,
        backoff: Scylla.INITIAL_BACKOFF_MS,
        region: process.env.SCYLLA_ACCESS_REGION ?? 'us-east-1',
        key: process.env.SCYLLA_ACCESS_KEY ?? '',
        secret: process.env.SCYLLA_ACCESS_PASSWORD ?? '',
        enableCache: process.env.ENABLE_CACHE === 'true', // enable in-process caches
        circuitBreaker: {
            enabled: true, // disable to bypass breaker entirely
            errorThresholdPercentage: 50, // % failures in window to open circuit
            volumeThreshold: 10, // minimum calls before error % is considered
            resetTimeout: 30000, // ms before half-open trial after open
            timeout: 10000, // ms action execution timeout (breaker-level)
        },
        concurrency: {
            maxConcurrent: 20, // max simultaneous in-flight requests
            maxQueue: 50, // max waiting promises; Infinity for unbounded
            queueBehavior: 'reject', // legacy: prefer queuePolicy.onSaturated options = [ 'reject' | 'wait' | 'error' ]
        },
        cacheBypass: {
            enabledForGetItemCacheHits: true, // if true, `getItem` cache hits skip guards
        },
        breakerMode: 'global', // use single global breaker or 'perOperation'
        queuePolicy: {
            onSaturated: 'reject', // when queue full: 'reject' | 'wait' | 'error'
        },
    };

    /**
     * ============================================================
     *  Low-level helpers
     *  ===========================================================
     */

    /**
     * Sign AWS request for Alternator Authentication
     */
    static signAwsRequest(target, payloadJson, amzDate, dateStamp) {
        if (!target || !payloadJson || !amzDate || !dateStamp) {
            throw new Error('signAwsRequest: missing required parameters');
        }

        const { key: accessKey, secret: secretKey, region } = Scylla.#config;
        const service = 'dynamodb';
        const host = `dynamodb.${region}.amazonaws.com`;
        const amzTarget = `DynamoDB_20120810.${target}`;

        /* ----- canonical request ------------------------------------------------ */
        const payloadHash = crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');

        const canonicalHeaders =
            `content-type:${Scylla.CONTENT_TYPE}\n` +
            `host:${host}\n` +
            `x-amz-date:${amzDate}\n` +
            `x-amz-target:${amzTarget}\n`;

        const signedHeaders = 'content-type;host;x-amz-date;x-amz-target';

        const canonicalRequest = [
            'POST',
            '/',
            '',
            canonicalHeaders,
            signedHeaders,
            payloadHash,
        ].join('\n');

        /* ----- STRING TO SIGN --------------------------------------------------- */
        const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
        const stringToSign = [
            'AWS4-HMAC-SHA256',
            amzDate,
            credentialScope,
            crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
        ].join('\n');

        /* ----- SIGNING KEY DERIVATION ------------------------------------------ */
        const hmac = (key, data) =>
            crypto.createHmac('sha256', key).update(data, 'utf8').digest();

        const kDate = hmac(`AWS4${secretKey}`, dateStamp);
        const kRegion = hmac(kDate, region);
        const kService = hmac(kRegion, service);
        const kSigning = hmac(kService, 'aws4_request');

        const signature = crypto
            .createHmac('sha256', kSigning)
            .update(stringToSign, 'utf8')
            .digest('hex');

        const authorizationHeader =
            `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`;

        return {
            'Content-Type': Scylla.CONTENT_TYPE,
            'X-Amz-Date': amzDate,
            'X-Amz-Target': amzTarget,
            'Authorization': authorizationHeader,
        };
    }

    /**
     * Low-level signed request with retry & back-off
     */
    static async request(target, payload = {}, port = Scylla.#config.port, agent = null) {
        if (!target || typeof payload !== 'object' || !Number.isInteger(port) || port <= 0) {
            throw new TypeError('ScyllaDb.request invalid arguments');
        }

        const operationType = 'general';
        const exec = () => Scylla.#coreRequest(target, payload, port, agent);
        const breaker = Scylla.#getBreaker(operationType);

        const guarded = () => (breaker ? breaker.fire(exec) : exec());
        return Scylla.#runWithLimiter(guarded);
    }

    /**
     * Core HTTP request with retries/backoff (isolated for breaker/limiter wrapping)
     */
    static async #coreRequest(target, payload = {}, port = Scylla.#config.port, agent = null) {
        let attempt = 0;
        let backoff = Scylla.#config.backoff;
        const maxTry = Scylla.#config.retries;

        const payloadJson = Object.keys(payload).length ? JSON.stringify(payload) : '{}';

        const baseUrl = new URL(Scylla.#config.endpoint);

        if (port) baseUrl.port = String(port);

        const transport = baseUrl.protocol === 'https:' ? https : http;
        const defaultPort = baseUrl.protocol === 'https:' ? 443 : 80;

        const userAgent = baseUrl.protocol === 'https:' ? (agent || Scylla.#persistentAgent) : undefined;

        while (true) {
            attempt += 1;

            const amzDate = (new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '').replace('Z', 'Z');
            const dateStamp = amzDate.slice(0, 8);

            const signedHeaders = Scylla.signAwsRequest(target, payloadJson, amzDate, dateStamp);

            const headers = {
                ...signedHeaders,
                'Content-Length': Buffer.byteLength(payloadJson),
                ...Scylla.#customRequestOptions.headers,
            };

            const reqOptions = {
                method: 'POST',
                hostname: baseUrl.hostname,
                port: baseUrl.port || defaultPort,
                path: baseUrl.pathname || '/',
                headers,
                agent: userAgent,
                timeout: 1000,
                ...Scylla.#customRequestOptions,
            };

            try {
                const body = await new Promise((resolve, reject) => {
                    const req = transport.request(reqOptions, res => {
                        let data = '';
                        res.setEncoding('utf8');
                        res.on('data', chunk => (data += chunk));
                        res.on('end', () => resolve({ status: res.statusCode, body: data }));
                    });

                    req.on('error', reject);
                    req.write(payloadJson);
                    req.end();
                });

                const { status, body: raw } = body;
                const parsed = raw ? JSON.parse(raw) : {};

                if (status === 200) {
                    return parsed;
                }

                const errorType = parsed?.__type ?? '';
                const throttled =
                    status === 400 &&
                    errorType.includes('ProvisionedThroughputExceededException');

                if ((throttled || status >= 500) && attempt < maxTry) {
                    await new Promise(r => setTimeout(r, backoff));
                    backoff *= 2;
                    continue;
                }

                const awsMsg = parsed?.message ?? '';
                const whatFailed = [errorType, awsMsg].filter(Boolean).join(' – ');

                const err = new Error(`ScyllaDb ${target} failed: ${whatFailed || status} (HTTP ${status})`);

                err.httpStatus = status;
                err.awsType = errorType;
                err.awsMsg = awsMsg;

                Scylla.#errors.push({
                    target,
                    httpCode: status,
                    awsErrorType: errorType,
                    awsErrorMsg: awsMsg,
                    responseBody: raw,
                    parsedResponse: parsed,
                    payload: payloadJson,
                    headers,
                });

                throw err;

            } catch (netErr) {
                if (attempt < maxTry) {
                    await new Promise(r => setTimeout(r, backoff));
                    backoff *= 2;
                    continue;
                }

                Scylla.#errors.push({
                    target,
                    httpCode: 0,
                    curlError: netErr.message,
                    payload: payloadJson,
                    headers,
                });
                throw netErr;
            }
        }
    }

    /* ===========================================================
     *      Schema / Meta
     * ==========================================================
     */

    /**
     * Describe table structure
     */
    static async describeTable(table) {
        if (!table) {
            throw new TypeError('describeTable: table name must not be empty');
        }

        if (!Scylla.#cache.describe[table]) {
            const resp = await Scylla.request('DescribeTable', { TableName: table }, Scylla.#config.port);
            Scylla.#cache.describe[table] = resp;
        }

        return Scylla.#cache.describe[table];
    }

    /**
     * List all table names
     * @returns {Promise<string[]>} An array of table names
     */
    static async listTables() {
        const response = await Scylla.request('ListTables', {}, Scylla.#config.port);
        return response.TableNames ?? [];
    }


    /**
     * Create a new table
     */
    static async createTable(schema) {
        if (!schema?.TableName) {
            throw new TypeError('createTable: schema.TableName is required');
        }

        delete Scylla.#cache.describe[schema.TableName];

        const resp = await Scylla.request('CreateTable', schema, Scylla.#config.port);
        return resp;
    }

    /**
     * Delete a table
     */
    static async deleteTable(table) {
        if (!table) {
            throw new TypeError('deleteTable: table name must not be empty');
        }

        delete Scylla.#cache.describe[table];

        const resp = await Scylla.request('DeleteTable', { TableName: table }, Scylla.#config.port);
        return resp;
    }

    /**
     * Load table configurations from file
     */
    static async loadTableConfigs(filePath) {
        if (!filePath) {
            throw new TypeError('loadTableConfigs: filePath is required');
        }

        let configs;
        const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();

        try {
            if (ext === 'json') {
                const raw = await fs.readFile(filePath, 'utf8');
                configs = JSON.parse(raw);
            } else {
                const mod = await import(pathToFileURL(filePath).href);
                configs = mod.default ?? mod;
            }
        } catch (err) {
            throw new Error(`Config file not found or unreadable: ${filePath}`);
        }

        if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
            throw new TypeError('Config file must export an object (tableName → config)');
        }

        Scylla.#tableConfigs = configs;
        console.log('Table configs loaded', { count: Object.keys(configs).length });
    }

    /**
     * Get schema from loaded config
     */
    static getSchemaFromConfig(table) {
        if (!table) {
            throw new TypeError('getSchemaFromConfig: table name is required');
        }

        const config = Scylla.#tableConfigs[table];
        if (!config) {
            throw new Error(`Table "${table}" not found in loaded configs`);
        }
        return config;
    }

    /**
     * Validate keys against table schema
     */
    static validateKeys(table, key) {
        if (!table) {
            throw new TypeError('validateKeys: table name is required');
        }

        if (!key || typeof key !== 'object' || Array.isArray(key)) {
            throw new TypeError('validateKeys: key must be a non-null object');
        }

        const config = Scylla.getSchemaFromConfig(table);
        const required = [config.PK];

        if (config.SK) required.push(config.SK);

        const missing = required.filter(
            attr => !(attr in key) || key[attr] === null || key[attr] === ''
        );

        if (missing.length) {
            throw new Error(`Missing required key attribute(s): ${missing.join(', ')}`);
        }

        return true;
    }

    /**
     * ============================================================
     *      CRUD Operations
     * ==========================================================
     */

    /**
     * Put item (insert or update)
     */
    static async putItem(table, item, options = {}, trackChange = false) {
        if (!table || !item || typeof item !== 'object') {
            throw new TypeError('putItem: table name and item object are required');
        }

        const cfg = Scylla.getSchemaFromConfig(table);
        const key = { [cfg.PK]: item[cfg.PK], ...(cfg.SK ? { [cfg.SK]: item[cfg.SK] } : {}) };
        Scylla.validateKeys(table, key);

        const payload = {
            TableName: table,
            Item: Scylla.marshalItem(item),
            ...(trackChange && { ReturnValues: 'ALL_OLD' }),
            ...options,
        };

        const resp = await Scylla.request('PutItem', payload, Scylla.#config.port);

        if (Scylla.#config.enableCache) {
            delete Scylla.#cache.getItem[Scylla.#itemCacheKey(table, key)];
        }

        return trackChange
            ? (resp.Attributes && Object.keys(resp.Attributes).length ? 'updated' : 'inserted')
            : true;
    }

    /**
     * Get an item by key
     */
    static async getItem(table, key) {
        if (!table || !key || typeof key !== 'object') {
            throw new TypeError('getItem: table name and key object are required');
        }
        Scylla.validateKeys(table, key);

        const ck = Scylla.#itemCacheKey(table, key);

        const allowCacheBypass = Scylla.#config.cacheBypass?.enabledForGetItemCacheHits !== false;
        if (allowCacheBypass && Scylla.#config.enableCache && Scylla.#cache.getItem[ck]) {
            return Scylla.#cache.getItem[ck];
        }

        const resp = await Scylla.request(
            'GetItem',
            { TableName: table, Key: Scylla.marshalItem(key) },
            Scylla.#config.port
        );

        if (!resp.Item) return false;

        const item = Scylla.unmarshalItem(resp.Item);

        if (Scylla.#config.enableCache) {
            Scylla.#cache.getItem[ck] = item;
        }
        return item;
    }

    /**
     * Delete item by key
     */
    static async deleteItem(table, key, options = {}) {
        if (!table || !key || typeof key !== 'object') {
            throw new TypeError('deleteItem: table name and key object are required');
        }
        Scylla.validateKeys(table, key);

        const ck = Scylla.#itemCacheKey(table, key);
        delete Scylla.#cache.getItem[ck];

        const payload = {
            TableName: table,
            Key: Scylla.marshalItem(key),
            ReturnValues: 'ALL_OLD',
            ...options,
        };

        const resp = await Scylla.request('DeleteItem', payload, Scylla.#config.port);
        return !!resp.Attributes;
    }

    /**
     * Update item by key, with data to be updated
     */
    static async updateItem(table, key, data) {
        if (!table || !key || !data || typeof key !== 'object' || typeof data !== 'object') {
            throw new TypeError('updateItem: table, key, and data objects are required');
        }
        Scylla.validateKeys(table, key);

        const exprNames = {};
        const exprValues = {};
        const parts = [];

        for (const [field, value] of Object.entries(data)) {
            const n = `#${field}`;
            const v = `:${field}`;
            exprNames[n] = field;
            exprValues[v] = value;
            parts.push(`${n} = ${v}`);
        }

        if (!parts.length) {
            throw new Error('updateItem: data object must have at least one attribute');
        }

        const payload = {
            TableName: table,
            Key: Scylla.marshalItem(key),
            UpdateExpression: `SET ${parts.join(', ')}`,
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: Scylla.marshalItem(exprValues),
            ReturnValues: 'ALL_NEW',
        };

        const resp = await Scylla.request('UpdateItem', payload, Scylla.#config.port);
        const attrs = resp.Attributes ? Scylla.unmarshalItem(resp.Attributes) : false;

        if (attrs && Scylla.#config.enableCache) {
            Scylla.#cache.getItem[Scylla.#itemCacheKey(table, key)] = attrs;
        }

        return attrs;
    }

    /* ============================================================
     * Batch operations
     * ==========================================================
     */

    /**
     * Batch write items (max 25)
     */
    static async batchWriteItem(table, items) {
        if (!table || !Array.isArray(items) || items.length === 0) {
            throw new TypeError('batchWriteItem: table and non-empty items array required');
        }
        if (items.length > 25) {
            throw new Error('BatchWriteItem limit is 25');
        }

        const cfg = Scylla.getSchemaFromConfig(table);
        for (const it of items) {
            const key = { [cfg.PK]: it[cfg.PK], ...(cfg.SK ? { [cfg.SK]: it[cfg.SK] } : {}) };
            Scylla.validateKeys(table, key);
        }

        const marshalled = items.map(it => ({ PutRequest: { Item: Scylla.marshalItem(it) } }));
        const payload = { RequestItems: { [table]: marshalled } };

        const resp = await Scylla.request('BatchWriteItem', payload, Scylla.#config.port);
        const unprocessed = resp.UnprocessedItems?.[table] ?? [];

        const unprocessedHashes = unprocessed.map(e =>
            Scylla.#md5(JSON.stringify(e.PutRequest.Item))
        );

        const results = { inserted: [], failed: [], unprocessed };

        items.forEach((it, i) => {
            const hash = Scylla.#md5(JSON.stringify(Scylla.marshalItem(it)));
            const id = it.id ?? `item_${i}`;

            if (unprocessedHashes.includes(hash)) {
                results.failed.push(id);
            } else {
                results.inserted.push(id);
            }
        });

        return results;
    }

    /**
     * Batch get items (max 25)
     */
    static async batchGetItem(table, keys) {
        if (!table || !Array.isArray(keys) || keys.length === 0) {
            throw new TypeError('batchGetItem: table and non-empty keys array required');
        }
        if (keys.length > 25) {
            throw new Error('BatchGetItem limit is 25');
        }

        keys.forEach(k => Scylla.validateKeys(table, k));

        const marshalledKeys = keys.map(k => Scylla.marshalItem(k));
        const payload = { RequestItems: { [table]: { Keys: marshalledKeys } } };

        const resp = await Scylla.request('BatchGetItem', payload, Scylla.#config.port);
        const fetched = resp.Responses?.[table] ?? [];

        const itemsById = {};
        fetched.forEach(it => {
            const u = Scylla.unmarshalItem(it);
            if (u.id !== undefined) itemsById[u.id] = u;
        });

        return keys.map(k => itemsById[k.id] ?? null);
    }

    /* ============================================================
     * Transaction Operations (simulated using batch operations)
     * ========================================================== */

    /**
     * Transaction write operations (simulated)
     * Since ScyllaDB Alternator doesn't support native transactions,
     * this method simulates transaction behavior using batch operations
     * with rollback capability on failure.
     */
    static async transactWrite(operations, options = {}) {
        if (!Array.isArray(operations) || operations.length === 0) {
            throw new TypeError('transactWrite: operations array is required');
        }
        if (operations.length > 25) {
            throw new Error('TransactWrite limit is 25 operations');
        }

        const { rollbackOnFailure = true, retryAttempts = 3 } = options;
        const originalItems = new Map(); // Store original state for rollback
        const operationResults = [];

        try {
            // Phase 1: Validate all operations and store original state
            for (const operation of operations) {
                if (!operation.table || !operation.action) {
                    throw new Error('Each operation must have table and action properties');
                }

                const { table, action, item, key, data } = operation;

                switch (action) {
                    case 'put':
                        if (!item) throw new Error('Put operation requires item');

                        const schema = Scylla.getSchemaFromConfig(table);
                        const putKey = { [schema.PK]: item[schema.PK] };

                        if (schema.SK) {
                            putKey[schema.SK] = item[schema.SK];
                        }

                        Scylla.validateKeys(table, putKey);
                        break;
                    case 'update':
                        if (!key || !data) throw new Error('Update operation requires key and data');

                        Scylla.validateKeys(table, key);

                        // Store original item for potential rollback
                        if (rollbackOnFailure) {
                            const original = await Scylla.getItem(table, key);
                            if (original) {
                                originalItems.set(`${table}:${JSON.stringify(key)}`, original);
                            }
                        }
                        break;
                    case 'delete':
                        if (!key) throw new Error('Delete operation requires key');

                        Scylla.validateKeys(table, key);

                        // Store original item for potential rollback
                        if (rollbackOnFailure) {
                            const original = await Scylla.getItem(table, key);
                            if (original) {
                                originalItems.set(`${table}:${JSON.stringify(key)}`, original);
                            }
                        }
                        break;
                    default:
                        throw new Error(`Unsupported action: ${action}`);
                }
            }

            // Phase 2: Execute operations
            for (const operation of operations) {
                const { table, action, item, key, data } = operation;
                let result;

                try {
                    switch (action) {
                        case 'put':
                            result = await Scylla.putItem(table, item);
                            break;
                        case 'update':
                            result = await Scylla.updateItem(table, key, data);
                            break;
                        case 'delete':
                            result = await Scylla.deleteItem(table, key);
                            break;
                    }
                    operationResults.push({ success: true, operation, result });
                } catch (error) {
                    operationResults.push({ success: false, operation, error });
                    throw error; // Stop execution on first failure
                }
            }

            return {
                success: true,
                results: operationResults,
                message: 'Transaction completed successfully'
            };

        } catch (error) {
            // Phase 3: Rollback if enabled and operations failed
            if (rollbackOnFailure && originalItems.size > 0) {
                console.warn('Transaction failed, attempting rollback...');

                try {
                    for (const [itemKey, originalItem] of originalItems) {
                        const [table, keyStr] = itemKey.split(':');
                        const key = JSON.parse(keyStr);

                        // Restore original item
                        await Scylla.putItem(table, originalItem);
                    }
                    console.log('Rollback completed successfully');
                } catch (rollbackError) {
                    console.error('Rollback failed:', rollbackError.message);
                    throw new Error(`Transaction failed and rollback failed: ${error.message}. Rollback error: ${rollbackError.message}`);
                }
            }

            throw new Error(`Transaction failed: ${error.message}`);
        }
    }

    /**
     * Transaction get operations (simulated)
     * Since ScyllaDB Alternator doesn't support native transactions,
     * this method simulates transaction behavior using batch operations.
     */
    static async transactGet(operations, options = {}) {
        if (!Array.isArray(operations) || operations.length === 0) {
            throw new TypeError('transactGet: operations array is required');
        }
        if (operations.length > 25) {
            throw new Error('TransactGet limit is 25 operations');
        }

        const { consistentRead = false } = options;
        const results = [];

        try {
            // Group operations by table for batch processing
            const tableOperations = new Map();

            for (const operation of operations) {
                if (!operation.table || !operation.key) {
                    throw new Error('Each operation must have table and key properties');
                }

                const { table, key } = operation;
                Scylla.validateKeys(table, key);

                if (!tableOperations.has(table)) {
                    tableOperations.set(table, []);
                }
                tableOperations.get(table).push({ key, operation });
            }

            // Execute batch gets for each table
            for (const [table, ops] of tableOperations) {
                const keys = ops.map(op => op.key);
                const batchResults = await Scylla.batchGetItem(table, keys);

                // Map results back to original operations
                for (let i = 0; i < ops.length; i++) {
                    results.push({
                        success: true,
                        operation: ops[i].operation,
                        item: batchResults[i]
                    });
                }
            }

            return {
                success: true,
                results,
                message: 'Transaction get completed successfully'
            };

        } catch (error) {
            throw new Error(`Transaction get failed: ${error.message}`);
        }
    }

    /* ============================================================
     *      Query and Scan
     * ============================================================
     */

    /**
     * Query items with conditions
     */
    static async query(table, keyConditionExpr, exprVals, options = {}) {
        if (!table || !keyConditionExpr || typeof exprVals !== 'object') {
            throw new TypeError('query: table, keyConditionExpr and exprVals are required');
        }

        const base = {
            TableName: table,
            KeyConditionExpression: keyConditionExpr,
            ExpressionAttributeValues: Scylla.marshalItem(exprVals),
        };

        let payload = { ...base, ...options };

        // Marshal additional ExpressionAttributeValues from options if present
        if (payload.ExpressionAttributeValues && options.ExpressionAttributeValues) {
            const additionalValues = Scylla.marshalItem(options.ExpressionAttributeValues);
            payload.ExpressionAttributeValues = { ...payload.ExpressionAttributeValues, ...additionalValues };
        }

        const items = [];

        do {
            const resp = await Scylla.request('Query', payload, Scylla.#config.port);
            (resp.Items ?? []).forEach(it => items.push(Scylla.unmarshalItem(it)));
            payload = { ...payload, ExclusiveStartKey: resp.LastEvaluatedKey ?? undefined };
        } while (payload.ExclusiveStartKey);

        return items;
    }

    /**
     * Scan all items in table
     */
    static async scan(table, options = {}) {
        if (!table) {
            throw new TypeError('scan: table name is required');
        }

        let payload = {
            TableName: table,
            ...options
        };

        // Marshal ExpressionAttributeValues if present
        if (payload.ExpressionAttributeValues) {
            payload.ExpressionAttributeValues = Scylla.marshalItem(payload.ExpressionAttributeValues);
        }

        const items = [];

        do {
            const resp = await Scylla.request('Scan', payload, Scylla.#config.port);
            (resp.Items ?? []).forEach(it => items.push(Scylla.unmarshalItem(it)));
            payload = { ...payload, ExclusiveStartKey: resp.LastEvaluatedKey ?? undefined };
        } while (payload.ExclusiveStartKey);

        return items;
    }

    /* ============================================================
     *      Configuration and Utilities
     * ============================================================
     * /

    /**
     * Configure ScyllaDb settings
     */
    static configure(config = {}) {
        if (typeof config !== 'object' || Array.isArray(config)) {
            throw new TypeError('configure: config must be an object');
        }

        /**
         * Merge partial configuration overrides.
         *
         * Accepted keys include nested sections: `circuitBreaker`, `concurrency`,
         * `cacheBypass`, `breakerMode`, and `queuePolicy`. Unknown keys are merged
         * shallowly. Guard components (limiter/breakers) are refreshed when changes
         * may affect behavior.
         *
         * Example:
         * Scylla.configure({
         *   circuitBreaker: { errorThresholdPercentage: 40, resetTimeout: 15000 },
         *   concurrency: { maxConcurrent: 10, maxQueue: 100 },
         *   queuePolicy: { onSaturated: 'wait' },
         * });
         */
        Scylla.#config = { ...Scylla.#config, ...config };
        Scylla.#refreshGuards();

        console.log('ScyllaDb config updated', { keys: Object.keys(config) });
        return true;
    }

    /**
   * Set custom request options
   */
    static setCurlOptions(opts = {}) {
        if (typeof opts !== 'object' || Array.isArray(opts)) {
            throw new TypeError('setCurlOptions: opts must be an object');
        }
        const { headers = {}, ...rest } = opts;
        Scylla.#customRequestOptions = { ...rest, headers };
        console.log('Custom request options set', { keys: Object.keys(rest) });
        return true;
    }

    /**
     * Begin persistent session
     */
    static beginSession() {
        const baseUrl = new URL(Scylla.#config.endpoint);
        if (baseUrl.protocol === 'https:' && !Scylla.#persistentAgent) {
            Scylla.#persistentAgent = new https.Agent({ keepAlive: true });
            console.log('Persistent HTTPS session started');
        } else if (baseUrl.protocol === 'http:') {
            console.log('HTTP session - no persistent agent needed');
        }
    }

    /**
     * End persistent session
     */
    static endSession() {
        if (Scylla.#persistentAgent) {
            Scylla.#persistentAgent.destroy();
            Scylla.#persistentAgent = null;
            console.log('Persistent HTTPS session closed');
        }
    }

    /**
     * Ensure concurrency limiter and breakers are aligned with current config
     */
    static #refreshGuards() {
        // Keep limiter/breakers aligned with new configuration.
        Scylla.#setupLimiter();
        Scylla.#resetBreakers();
    }

    static #setupLimiter() {
        const { concurrency = {} } = Scylla.#config;
        const { maxConcurrent } = concurrency;

        if (!maxConcurrent || !Number.isFinite(maxConcurrent) || maxConcurrent <= 0) {
            Scylla.#limiter = null; // unlimited
            return;
        }

        Scylla.#limiter = pLimit(maxConcurrent);
    }

    static #resetBreakers() {
        // Reset breaker caches; recreated lazily on next use.
        Scylla.#breaker = null;
        Scylla.#operationBreakers = {};
    }

    static #getBreaker(operationType) {
        const cbCfg = Scylla.#config.circuitBreaker ?? {};
        if (cbCfg.enabled === false) return null;

        // opossum breaker options
        const opts = {
            timeout: cbCfg.timeout ?? 10000,
            errorThresholdPercentage: cbCfg.errorThresholdPercentage ?? 50,
            volumeThreshold: cbCfg.volumeThreshold ?? 10,
            resetTimeout: cbCfg.resetTimeout ?? 30000,
        };

        const mode = Scylla.#config.breakerMode === 'perOperation' ? 'perOperation' : 'global';

        const build = (op) => {
            // The breaker wraps a function that returns a promise-producing function.
            const br = new CircuitBreaker(fn => fn(), opts);
            br.on('open', () => console.warn('Scylla breaker open', { operationType: op }));
            br.on('halfOpen', () => console.warn('Scylla breaker half-open', { operationType: op }));
            br.on('close', () => console.log('Scylla breaker closed', { operationType: op }));
            br.on('timeout', () => console.warn('Scylla breaker timeout', { operationType: op }));
            br.on('reject', () => console.warn('Scylla breaker rejected', { operationType: op }));
            return br;
        };

        if (mode === 'perOperation') {
            if (!Scylla.#operationBreakers[operationType]) {
                Scylla.#operationBreakers[operationType] = build(operationType);
            }
            return Scylla.#operationBreakers[operationType];
        }

        if (!Scylla.#breaker) {
            Scylla.#breaker = build('global');
        }
        return Scylla.#breaker;
    }

    static #runWithLimiter(fn) {
        // Lazily initialize limiter if not set.
        if (Scylla.#limiter === null) {
            Scylla.#setupLimiter();
        }

        const limit = Scylla.#limiter;
        if (!limit) return fn();

        const { concurrency = {}, queuePolicy = {} } = Scylla.#config;
        const { maxQueue = Infinity, queueBehavior = queuePolicy.onSaturated } = concurrency;
        const onSaturated = queuePolicy.onSaturated ?? queueBehavior ?? 'reject';

        if (Number.isFinite(maxQueue) && maxQueue >= 0) {
            const pending = limit.pendingCount ?? 0;
            if (pending >= maxQueue && onSaturated !== 'wait') {
                const err = new Error('Scylla request queue saturated');
                err.code = 'SCYLLA_QUEUE_SATURATED';
                throw err;
            }
        }

        // Queue the function respecting maxConcurrent and queue limits.
        return limit(fn);
    }

    /**
     * Get error history
     */
    static getErrors() {
        return Scylla.#errors;
    }

    /**
     * Clear cache
     */
    static clearCache(type = null) {
        if (!type) {
            Scylla.#cache = { getItem: {}, scan: {}, describe: {} };
            console.log('All in-process caches cleared');
            return;
        }

        if (!(type in Scylla.#cache)) {
            throw new Error(`clearCache: unknown cache bucket "${type}"`);
        }
        Scylla.#cache[type] = {};
        console.log(`Cache bucket "${type}" cleared`);
    }

    /**
     * Raw request wrapper
     */
    static async rawRequest(target, payload = {}) {
        return Scylla.request(target, payload, Scylla.#config.port);
    }

    /* ============================================================
     * Marshalling helpers
     * ============================================================
     * /

    /**
     * Marshal value to DynamoDB format
     */
    static marshalValue(v) {
        if (v === null || v === undefined) {
            return { NULL: true };
        }
        if (typeof v === 'boolean') {
            return { BOOL: v };
        }
        if (typeof v === 'number' || (typeof v === 'bigint')) {
            return { N: v.toString() };
        }
        if (Array.isArray(v)) {
            return { L: v.map(el => Scylla.marshalValue(el)) };
        }
        if (typeof v === 'object') {
            const out = {};
            for (const [k, val] of Object.entries(v)) {
                out[k] = Scylla.marshalValue(val);
            }
            return { M: out };
        }
        return { S: String(v) };
    }

    /**
     * Marshal item to DynamoDB format
     */
    static marshalItem(data) {
        if (typeof data !== 'object' || data === null) {
            throw new TypeError('marshalItem expects a plain object');
        }
        const out = {};
        for (const [k, v] of Object.entries(data)) {
            out[k] = Scylla.marshalValue(v);
        }
        return out;
    }

    /**
     * Check if item is marshalled
     */
    static isMarshalledItem(item) {
        if (!item || typeof item !== 'object') return false;

        const VALID = ['S', 'N', 'BOOL', 'NULL', 'L', 'M'];
        return Object.values(item).every(v =>
            typeof v === 'object' &&
            v !== null &&
            Object.keys(v).length === 1 &&
            VALID.includes(Object.keys(v)[0])
        );
    }

    /**
     * Unmarshal item from DynamoDB format
     */
    static unmarshalItem(item) {
        if (!item || typeof item !== 'object') return {};

        const out = {};

        const convert = (typed) => {
            const type = Object.keys(typed)[0];
            const val = typed[type];

            switch (type) {
                case 'S': return val;
                case 'N': return val.includes('.') ? parseFloat(val) : parseInt(val, 10);
                case 'BOOL': return !!val;
                case 'NULL': return null;
                case 'L': return val.map(el => convert(el));
                case 'M': {
                    const m = {};
                    for (const [k, v] of Object.entries(val)) m[k] = convert(v);
                    return m;
                }
                default: return val;
            }
        };

        for (const [k, typed] of Object.entries(item)) {
            out[k] = convert(typed);
        }
        return out;
    }

    /* ---------- private utilities ---------- */
    static #itemCacheKey(table, keyObj) {
        return `${table}:${JSON.stringify(keyObj)}`;
    }

    static #md5(json) {
        return crypto.createHash('md5').update(json).digest('hex');
    }
}

module.exports = Scylla;
