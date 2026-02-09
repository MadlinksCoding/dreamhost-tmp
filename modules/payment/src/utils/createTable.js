const path = require('path');
const fs = require('fs');
const ScyllaDb = require('./ScyllaDb.js');

async function createAllTablesFromJson(tablesPath) {
  const resolvedPath = tablesPath || path.join(__dirname, 'tables.json');
  const config = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  const tables = config.tables || [];
  const results = [];
  for (const tableConfig of tables) {
    const tableName = tableConfig.TableName;
    try {
      const exists = await ScyllaDb.tableExists(tableName);
      if (exists) {
        console.log(`Table ${tableName} already exists, skipping.`);
        results.push({ table: tableName, created: false });
      } else {
        await ScyllaDb.createTable(tableConfig);
        console.log(`Created table: ${tableName}`);
        results.push({ table: tableName, created: true });
      }
    } catch (err) {
      if (err.name === 'ResourceInUseException') {
        console.log(`Table ${tableName} already exists, skipping.`);
        results.push({ table: tableName, created: false });
      } else {
        throw err;
      }
    }
  }
  return results;
}

module.exports = { createAllTablesFromJson };