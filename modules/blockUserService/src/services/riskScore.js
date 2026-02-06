import fs from "fs";
import path from "path";

/**
 * Calculate risk score for a user based on their block history and config.
 * @param {Array} blocks - Array of block objects (active and expired).
 * @param {Object} [config] - Optional config object. If not provided, loads from config file.
 * @returns {number} Total risk score.
 */
export async function calculateRiskScore(blocks, config) {
  if (!config) {
    const configPath = path.resolve(
      process.cwd(),
      "config/riskScoreConfig.json"
    );
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  const scopes = config.scopes || {};
  let score = 0;
  for (const block of blocks) {
    if (block.deleted_at || block.expires_at < Date.now()) {
      // Expired or deleted block
      score += scopes.expired_block || 0;
    } else if (scopes[block.scope]) {
      score += scopes[block.scope];
    }
  }
  return score;
}
