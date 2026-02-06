import Scylla from "../src/services/scylla.js";
import Moderation from '../src/core/moderation.js';
import { fileURLToPath } from 'url';

import { dirname, join } from 'path';
// Get the directory of the current file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const schemaPath = join(__dirname, '../src/core/db_schema.json');


async function main() {
    await Scylla.loadTableConfigs(schemaPath);
    console.log("=== Manual test: updateStatusIndex ===");

    const type = 'text';
    const start = null;
    const end = null;

    const res = await Moderation.getModerationItemsByType(type, {
        limit: 100,
        start,
        end,
        asc: false
    });

    console.log(`Type "${type}": ${res.items.length} item(s)`);
    console.log("hasMore:", res.hasMore, "nextToken:", res.nextToken);
}

main();
