import { createClient } from "redis";

class RedisClient {
    constructor() {
        this.client = null;
        this.url = process.env.REDIS_URL || "redis://localhost:6379";
    }

    _assertConnected() {
        if (!this.client || !this.client.isOpen) {
            throw new Error("Redis client is not connected. Call Redis.connect() first.");
        }
    }

    async connect(url) {
        if (this.client && this.client.isOpen) return; // idempotent
        this.client = createClient({ url: url || this.url });

        this.client.on("error", (err) => {
            console.error("Redis Client Error:", err);
        });

        await this.client.connect();
    }

    async disconnect() {
        if (this.client && this.client.isOpen) {
            await this.client.quit();
        }
    }

    async set(key, value, options = {}) {
        this._assertConnected();

        let toStore;
        if (typeof value === "string") {
            toStore = value;
        } else {
            toStore = JSON.stringify(value);
        }

        if (options.EX) {
            await this.client.set(key, toStore, { EX: options.EX });
        } else if (options.PX) {
            await this.client.set(key, toStore, { PX: options.PX });
        } else {
            await this.client.set(key, toStore);
        }

        return { key, result: value };
    }

    async get(key) {
        this._assertConnected();
        return this.client.get(key);
    }

    async del(keys) {
        this._assertConnected();

        if (!Array.isArray(keys)) {
            keys = [keys];
        }

        if (keys.length === 0) return 0;
        return this.client.del(keys);
    }

    async keys(pattern = "*") {
        this._assertConnected();
        return this.client.keys(pattern);
    }

    async scan(pattern = "*", count = 100) {
        this._assertConnected();
        const out = [];
        for await (const key of this.client.scanIterator({ MATCH: pattern, COUNT: count })) {
            out.push(key);
        }
        return out;
    }

    async getAllKeysAndValues(pattern = "*") {
        this._assertConnected();
        const keys = await this.scan(pattern);
        if (keys.length === 0) return [];

        const values = await this.client.mGet(keys);
        return keys.map((key, i) => {
            const raw = values[i];
            if (raw === null) return { key, result: null };

            try {
                return { key, result: JSON.parse(raw) };
            } catch (_) {
                const num = Number(raw);
                if (!Number.isNaN(num) && raw.trim() !== "") {
                    return { key, result: num };
                }
                return { key, result: raw };
            }
        });
    }

    /**
     * Checks whether a given key exists in Redis.
     * Returns true if the key exists, false otherwise.
     */
    async has(key) {
        this._assertConnected();
        const exists = await this.client.exists(key);
        return exists > 0;
    }
}

const redis = new RedisClient();
export default redis;
