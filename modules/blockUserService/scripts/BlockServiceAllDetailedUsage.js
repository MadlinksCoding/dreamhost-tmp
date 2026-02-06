import { fileURLToPath } from 'url';

import { dirname, join } from 'path';
// Get the directory of the current file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const schemaPath = join(__dirname, '../src/services/scylla/scylla-schema-config.json');
// src/services/scylla/scylla-schema-config.json

import { BlockService } from "../src/services/BlockService.js";
import ScyllaDb from "../src/services/scylla/scyllaDb.js";

async function runDetailedExamples() {
  const uid = "user123"; // Blocker ID
  const other = "user999"; // Blocked user ID
  const ip = "1.2.3.4";
  const email = "test@example.com";
  const key = "custom:test:key";

  console.log("=== Running Detailed Examples for BlockService ===");

  console.log("\n[INIT] Loading ScyllaDB table configurations...");
  await ScyllaDb.loadTableConfigs(schemaPath);
  console.log("[OK] Table configurations loaded successfully.");

  // console.log("\n[1] blockUser()");
  // console.log("Input:", {
  //   uid,
  //   other,
  //   scope: "chat",
  //   options: { permanent: true, reason: "abuse", flag: "abuse" },
  // });
  // const blockedUser = await BlockService.blockUser(uid, other, "chat", {
  //   permanent: true,
  //   reason: "abuse",
  //   flag: "abuse",
  // });
  // console.log("[OK] User blocked successfully.", blockedUser);

  // console.log("\n[2] isUserBlocked()");
  // console.log("Input:", { uid, other, scope: "chat" });
  // const isBlocked = await BlockService.isUserBlocked(uid, other, "chat");
  // console.log("Output:", isBlocked);

  // console.log("\n[3] unblockUser()");
  // console.log("Input:", { uid, other, scope: "chat" });
  // const unblocked = await BlockService.unblockUser(uid, other, "chat");
  // console.log("[OK] User unblocked successfully.", unblocked);

  console.log("\n[4] batchCheckUserBlocks()");
  const batchInput = [{ from: uid, to: other, scope: "chat" }];
  console.log("Input:", batchInput);
  const batchResults = await BlockService.batchCheckUserBlocks(batchInput);
  console.log("Output:", batchResults);

  // console.log("\n[5] blockIP()");
  // console.log("Input:", { ip, reason: "spam" });
  // await BlockService.blockIP(ip, "spam");
  // console.log("[OK] IP blocked successfully.");

  // console.log("\n[6] isIPBlocked()");
  // console.log("Input:", { ip });
  // const ipBlocked = await BlockService.isIPBlocked(ip);
  // console.log("Output:", ipBlocked);

  // console.log("\n[7] blockEmail()");
  // console.log("Input:", { email, reason: "signup spam" });
  // await BlockService.blockEmail(email, "signup spam");
  // console.log("[OK] Email blocked successfully.");

  // console.log("\n[8] isEmailBlocked()");
  // console.log("Input:", { email });
  // const emailBlocked = await BlockService.isEmailBlocked(email);
  // console.log("Output:", emailBlocked);

  // console.log("\n[9] blockAppAccess()");
  // console.log("Input:", { uid, app: "dashboard", reason: "ban for abuse" });
  // await BlockService.blockAppAccess(uid, "dashboard", "ban for abuse");
  // console.log("[OK] App access blocked successfully.");

  // console.log("\n[10] isAppAccessBlocked()");
  // console.log("Input:", { uid, app: "dashboard" });
  // const appBlocked = await BlockService.isAppAccessBlocked(uid, "dashboard");
  // console.log("Output:", appBlocked);

  // console.log("\n[11] suspendUser()");
  // console.log("Input:", {
  //   uid,
  //   reason: "TOS violation",
  //   admin: "admin1",
  //   category: "violence",
  //   details: "threats made in chat",
  // });
  // await BlockService.suspendUser(
  //   uid,
  //   "TOS violation",
  //   "admin1",
  //   "violence",
  //   "threats made in chat"
  // );
  // console.log("[OK] User suspended successfully.");

  // console.log("\n[12] isUserSuspended()");
  // console.log("Input:", { uid });
  // const suspended = await BlockService.isUserSuspended(uid);
  // console.log("Output:", suspended);

  // console.log("\n[13] unsuspendUser()");
  // console.log("Input:", { uid });
  // await BlockService.unsuspendUser(uid);
  // console.log("[OK] User unsuspended successfully.");

  // console.log("\n[14] warnUser()");
  // console.log("Input:", {
  //   uid,
  //   category: "spam",
  //   admin: "admin2",
  //   details: "excessive posting",
  // });
  // await BlockService.warnUser(uid, "spam", "admin2", "excessive posting");
  // console.log("[OK] User warned successfully.");

  // console.log("\n[15] getUserManualActions()");
  // console.log("Input:", { uid });
  // const logs = await BlockService.getUserManualActions(uid);
  // console.log("Output:", logs);

  // console.log("\n=== All examples completed successfully ===");
}

runDetailedExamples();
