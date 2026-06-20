// Standalone Firebase Admin write/read/delete check (Phase 2 feasibility gate).
//
// Purpose: prove that the downloaded service-account key can write to your
// Realtime Database with admin privileges (rules are bypassed), independent of
// the rest of the app. It writes one node under /_healthcheck, reads it back,
// then deletes it.
//
// Usage (from article-to-slides-automation/):
//   1) npm i firebase-admin
//   2) set these in .env (or ~/.content-extractor/.env):
//        FIREBASE_DATABASE_URL=https://<project-id>-default-rtdb.asia-southeast1.firebasedatabase.app
//        FIREBASE_SERVICE_ACCOUNT_PATH=C:\Users\lomox\.content-extractor\firebase-admin.json
//   3) node scripts/verify-firebase-admin.mjs
//
// This file is plain ESM (.mjs) and lives outside src/, so it does not affect
// `tsc` build/typecheck.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- 1. Load .env exactly like src/config.ts (local first, home fallback, no override) ---
function applyEnvFile(envPath) {
  try {
    if (!existsSync(envPath)) return;
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const i = trimmed.indexOf("=");
      if (i === -1) continue;
      const key = trimmed.slice(0, i).trim();
      const value = trimmed.slice(i + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* env files are optional */
  }
}
applyEnvFile(".env");
applyEnvFile(join(homedir(), ".content-extractor", ".env"));

function fail(msg, hint) {
  console.error(`\n❌ ${msg}`);
  if (hint) console.error(`   → ${hint}`);
  process.exit(1);
}

// --- 2. Validate required configuration ---
const databaseURL = process.env.FIREBASE_DATABASE_URL;
const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

if (!databaseURL) {
  fail("FIREBASE_DATABASE_URL is not set.", "Add it to .env (see the Realtime Database console URL).");
}
if (!keyPath) {
  fail("FIREBASE_SERVICE_ACCOUNT_PATH is not set.", "Point it at the downloaded *-firebase-adminsdk-*.json file.");
}
if (!existsSync(keyPath)) {
  fail(`Service account file not found: ${keyPath}`, "Check the path (Windows paths can use \\\\ or /).");
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
} catch (e) {
  fail(`Service account file is not valid JSON: ${keyPath}`, String(e?.message || e));
}
for (const field of ["project_id", "client_email", "private_key"]) {
  if (!serviceAccount[field]) {
    fail(`Service account JSON is missing "${field}".`, "Re-download the key from Project settings → Service accounts.");
  }
}

// Sanity: the databaseURL host usually starts with the project_id.
const urlProject = (() => {
  try {
    return new URL(databaseURL).hostname.split(".")[0].replace(/-default-rtdb$/, "");
  } catch {
    return "";
  }
})();
if (urlProject && urlProject !== serviceAccount.project_id) {
  console.warn(
    `⚠️  databaseURL project "${urlProject}" != key project "${serviceAccount.project_id}". ` +
      "Make sure both belong to the same Firebase project."
  );
}

console.log("Config OK:");
console.log(`  project_id   : ${serviceAccount.project_id}`);
console.log(`  client_email : ${serviceAccount.client_email}`);
console.log(`  databaseURL  : ${databaseURL}`);

// --- 3. Load firebase-admin (graceful message if not installed) ---
let cert, initializeApp, getDatabase;
try {
  ({ cert, initializeApp } = await import("firebase-admin/app"));
  ({ getDatabase } = await import("firebase-admin/database"));
} catch {
  fail("firebase-admin is not installed.", "Run: npm i firebase-admin");
}

// --- 4. Write → read → delete under /_healthcheck ---
const app = initializeApp({ credential: cert(serviceAccount), databaseURL });
const db = getDatabase(app);
const stamp = new Date().toISOString();
const ref = db.ref(`/_healthcheck/verify-${Date.now()}`);

try {
  const payload = { ok: true, at: stamp, by: "verify-firebase-admin.mjs" };
  console.log(`\nWriting ${ref.toString()} ...`);
  await ref.set(payload);

  const snap = await ref.get();
  const readBack = snap.val();
  console.log("Read back:", JSON.stringify(readBack));

  if (!readBack || readBack.at !== stamp) {
    fail("Read-back did not match what was written.", "Unexpected — inspect the Realtime Database console.");
  }

  await ref.remove();
  console.log("Cleaned up test node.");

  console.log("\n✅ SUCCESS: admin write/read/delete works against Realtime Database.");
  console.log("   (You can confirm in the console; the node was removed after the check.)");
  process.exit(0);
} catch (e) {
  const msg = String(e?.message || e);
  let hint = "See the message above.";
  if (/PERMISSION_DENIED/i.test(msg)) {
    hint = "Unexpected for admin SDK — confirm the databaseURL matches the key's project.";
  } else if (/ENOTFOUND|EAI_AGAIN|network|ETIMEDOUT/i.test(msg)) {
    hint = "Network/DNS issue reaching the database host. Check the URL and connectivity.";
  } else if (/invalid.*credential|Failed to (parse|determine)/i.test(msg)) {
    hint = "The service account key looks invalid. Re-download it.";
  } else if (/database URL|Can't determine Firebase Database URL/i.test(msg)) {
    hint = "FIREBASE_DATABASE_URL is malformed. Copy it exactly from the RTDB console.";
  }
  fail(`Firebase operation failed: ${msg}`, hint);
}
