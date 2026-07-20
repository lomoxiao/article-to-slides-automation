import { spawn, type ChildProcess } from "node:child_process";

// claudeRunner / codexRunner で共用する CLI サブプロセス実行の共通基盤。
// 「spawn → stdin にプロンプト → stdout/stderr 収集 → タイムアウトで kill」の骨格のみを持ち、
// 引数構築・ログファイル書き出し・結果パースは各 runner 側の責務のまま残す。

export type CliRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type SpawnCliOptions = {
  /** stdin へ流し込んで閉じる文字列(プロンプト本文)。 */
  stdin?: string;
  timeoutMs: number;
  /**
   * Windows の .cmd シム(claude 等)は shell 経由でしか起動できないため true にする。
   * その場合、引数は単純トークンのみに限定し、外部入力は必ず stdin 側へ渡すこと。
   */
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  /** タイムアウト時に Windows でプロセスツリーごと殺す(taskkill /T /F)。 */
  killTree?: boolean;
  /** タイムアウト時に投げるエラーを部分出力から生成する(未指定なら汎用 Error)。 */
  timeoutError?: (partial: { stdout: string; stderr: string }) => Error;
};

export function spawnCli(
  command: string,
  args: string[],
  options: SpawnCliOptions
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        shell: options.shell ?? false,
        env: options.env ?? process.env,
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error =
        options.timeoutError?.({ stdout, stderr }) ??
        new Error(`${command} timed out after ${options.timeoutMs}ms`);
      if (options.killTree) {
        void terminateProcessTree(child).finally(() => {
          reject(error);
        });
      } else {
        child.kill();
        reject(error);
      }
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      reject(error);
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      resolve({ exitCode, stdout, stderr });
    });

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin, "utf8");
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Windows では child.kill() が子孫プロセスを残すため、taskkill /T でツリーごと落とす。
 * taskkill 自体が失敗・停滞した場合は素の kill にフォールバックする。
 */
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }

  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimeout);
      resolve();
    };
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true
    });
    const killTimeout = setTimeout(() => {
      killer.kill();
      child.kill();
      finish();
    }, 5_000);

    killer.once("error", () => {
      child.kill();
      finish();
    });
    killer.once("close", (exitCode) => {
      if (exitCode !== 0) {
        child.kill();
      }
      finish();
    });
  });
}
