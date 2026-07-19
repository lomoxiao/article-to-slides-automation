import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { getDb } from "./firebaseAdmin.js";

// セッションの状態を viewer から読めるよう RTDB へ公開する。
// 「今有効か」は使うまで分からないため、記録するのは
//  - lastResult: 最後に抽出で使った結果(ok/expired/unknown)
//  - cookieExpiresAt: storageState内cookieの最短expires(B: 予測の目安)
// の2軸。ドメインは RTDB キーに '.' が使えないため '_' 置換キーにし、実値は field で持つ。

type SessionLastResult = "ok" | "expired" | "unknown";

type SessionStatusRecord = {
  domain: string;
  lastResult: SessionLastResult;
  lastCheckedAt: string;
  capturedAt?: string;
  cookieExpiresAt?: string | null;
};

function nowJstIso(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace("Z", "+09:00");
}

function domainKey(domain: string): string {
  return domain.replace(/[.#$/[\]]/g, "_");
}

function sessionsDir(): string {
  return config.WEB_SESSIONS_DIR;
}

function sessionPathOf(domain: string): string {
  return join(sessionsDir(), `${domain}.json`);
}

/**
 * storageState の cookies から、期限付きcookieの最短 expires(ISO)を返す。
 * 全てセッションcookie(expires<=0)なら null(=期限予測不能)。
 */
export function readCookieExpiry(sessionPath: string): string | null {
  try {
    const state = JSON.parse(readFileSync(sessionPath, "utf8")) as {
      cookies?: Array<{ expires?: number }>;
    };
    const expiries = (state.cookies ?? [])
      .map((cookie) => cookie.expires)
      .filter((value): value is number => typeof value === "number" && value > 0);
    if (!expiries.length) return null;
    const earliest = Math.min(...expiries);
    return new Date(earliest * 1000).toISOString();
  } catch {
    return null;
  }
}

async function writeStatus(domain: string, patch: Partial<SessionStatusRecord>): Promise<void> {
  try {
    await getDb()
      .ref(`/sessionStatus/${domainKey(domain)}`)
      .update({ domain, lastCheckedAt: nowJstIso(), ...patch });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[session-status] write failed for ${domain}: ${message}`);
  }
}

/** session:capture 成功時。取得直後は有効とみなし、cookie期限も更新する。 */
export async function recordSessionCaptured(domain: string): Promise<void> {
  const path = sessionPathOf(domain);
  await writeStatus(domain, {
    lastResult: "ok",
    capturedAt: nowJstIso(),
    cookieExpiresAt: existsSync(path) ? readCookieExpiry(path) : null
  });
}

/** 抽出で SessionExpiredError を検知したとき。 */
export async function recordSessionExpired(domain: string): Promise<void> {
  await writeStatus(domain, { lastResult: "expired" });
}

/**
 * daemon起動時: セッションdirを走査し、RTDB未登録のドメインを unknown で登録、
 * cookie期限は毎回読み直す(ファイルが更新されている可能性があるため)。
 */
export async function reconcileSessionStatuses(
  logger: Pick<Console, "log" | "warn"> = console
): Promise<void> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }

  for (const file of files) {
    const domain = file.replace(/\.json$/, "");
    const path = join(dir, file);
    try {
      const snapshot = await getDb().ref(`/sessionStatus/${domainKey(domain)}`).get();
      const existing = snapshot.exists() ? (snapshot.val() as SessionStatusRecord) : undefined;
      await writeStatus(domain, {
        lastResult: existing?.lastResult ?? "unknown",
        capturedAt: existing?.capturedAt ?? statSync(path).mtime.toISOString(),
        cookieExpiresAt: readCookieExpiry(path)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[session-status] reconcile failed for ${domain}: ${message}`);
    }
  }
  logger.log(`[session-status] reconciled ${files.length} session file(s)`);
}
