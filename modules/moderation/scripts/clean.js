import { fileURLToPath } from 'url';
import Scylla from "../src/services/scylla.js";

const __filename = fileURLToPath(import.meta.url);

const MODERATION_TABLE = 'moderation';

export async function clean() {
    const tables = await Scylla.listTables();

    if (tables.includes(MODERATION_TABLE)) {
        console.log('(INFO) Table exists. Deleting...');

        try {
            await Scylla.deleteTable(MODERATION_TABLE);
            console.log('(INFO) Table schema deleted successfully');
        } catch (error) {
            console.log('(ERROR) Table schema could not be deleted:', error);
            process.exit(1);
        }
    } else {
        console.log('(INFO) Nothing to delete. Table "moderation" not found.');
    }
}

if (process.argv[1] === __filename) {
    (async () => {
        await clean();
    })();
}

