import ScyllaDb from './scyllaDb.js';
import { promises as fs } from 'fs';

async function generateConfig(outputFile = 'scylla-schema-config.json') {
  console.log('process.env.SCYLLA_ALTERNATOR_ENDPOINT:', process.env.SCYLLA_ALTERNATOR_ENDPOINT);
  await ScyllaDb.configure(); // Use env/config as needed

  const tables = await ScyllaDb.listTables();
  const config = {};

  for (const table of tables) {
    const desc = await ScyllaDb.describeTable(table);
    const keySchema = desc.Table.KeySchema;
    const pk = keySchema.find(k => k.KeyType === 'HASH')?.AttributeName;
    const sk = keySchema.find(k => k.KeyType === 'RANGE')?.AttributeName;
    const fields = desc.Table.AttributeDefinitions.map(attr => ({
      name: attr.AttributeName,
      type: attr.AttributeType
    }));

    config[table] = {
      PK: pk,
      ...(sk ? { SK: sk } : {}),
      Fields: fields
    };
  }

  await fs.writeFile(outputFile, JSON.stringify(config, null, 2));
  console.log(`Config written to ${outputFile}`);
}

generateConfig().catch(console.error);