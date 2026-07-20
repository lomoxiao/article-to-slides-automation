import { existsSync, readFileSync } from "node:fs";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getDatabase, type Database } from "firebase-admin/database";
import { loadDotEnv } from "../utils/envFile.js";

// Load .env (local first, home fallback, no override) so local runs of the
// dispatch script pick up FIREBASE_* from .env. In GitHub Actions the variables
// are injected directly and these files are absent (no-op).
// Deliberately does NOT import src/config.ts: this module must stay usable from
// minimal contexts (GitHub Actions) without pulling in the full config surface.
loadDotEnv();

let cachedDb: Database | undefined;

/**
 * Lazily initialise the Firebase Admin app and return the Realtime Database
 * handle. Admin credentials bypass security rules, so this can read/write
 * /articles even while the database is in locked mode.
 *
 * Credentials are read from the environment in two modes:
 *  - FIREBASE_SERVICE_ACCOUNT_JSON : inline JSON string (GitHub Actions secret)
 *  - FIREBASE_SERVICE_ACCOUNT_PATH : path to the downloaded key file (local)
 * FIREBASE_DATABASE_URL is always required.
 */
export function getDb(): Database {
  if (cachedDb) {
    return cachedDb;
  }
  const databaseURL = requireEnv("FIREBASE_DATABASE_URL");
  const serviceAccount = loadServiceAccount();
  const app: App = getApps()[0] ?? initializeApp({
    credential: cert(serviceAccount),
    databaseURL
  });
  cachedDb = getDatabase(app);
  return cachedDb;
}

// Returns the parsed service account JSON. Typed as `any` because firebase-admin's
// cert() accepts the snake_case Google key object at runtime (the documented
// `cert(require('key.json'))` pattern), while the ServiceAccount type is camelCase.
function loadServiceAccount(): any {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (error) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${(error as Error).message}`, { cause: error });
    }
  }

  const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  if (!keyPath) {
    throw new Error("Set FIREBASE_SERVICE_ACCOUNT_JSON (inline) or FIREBASE_SERVICE_ACCOUNT_PATH (file).");
  }
  if (!existsSync(keyPath)) {
    throw new Error(`Service account file not found: ${keyPath}`);
  }
  try {
    return JSON.parse(readFileSync(keyPath, "utf8"));
  } catch (error) {
    throw new Error(`Service account file is not valid JSON: ${keyPath} (${(error as Error).message})`, { cause: error });
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

