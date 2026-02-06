const dotenv = require('dotenv');
dotenv.config();

const DB = require('../src/utils/DB.js');

async function dropTables() {
    const db = new DB();

    try {
        await db.ensureConnected('default');
        console.log('✅ Connected to PostgreSQL');

        const tables = [
            'collection_media',
            'media_coperformers',
            'media_tags',
            'collections',
            'media_audit',
            'media',
        ];

        for (const table of tables) {
            console.log(`🗑️ Dropping table: ${table}...`);
            await db.query('default', `DROP TABLE IF EXISTS ${table} CASCADE;`);
            console.log(`✅ Table dropped: ${table}`);
        }

        console.log('✅ All tables dropped successfully!');

        const remainingTables = await db.getAll(
            'default',
            `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `,
        );

        if (remainingTables.length === 0) {
            console.log('📊 All tables successfully removed - database is empty');
        } else {
            console.log(
                '📊 Remaining tables:',
                remainingTables.map((t) => t.table_name).join(', '),
            );
        }
    } catch (err) {
        console.error('❌ Error dropping tables:', err);

        const dbErrors = db.getErrors();
        if (dbErrors.length > 0) {
            console.error('📋 DB Errors:', dbErrors);
        }
    } finally {
        await db.closeAll();
        console.log('🔌 All connections closed');
    }
}

dropTables().catch(console.error);
