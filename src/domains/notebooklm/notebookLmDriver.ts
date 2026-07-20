import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { config } from "../../config.js";

// NotebookLM を決定論的に操作する Playwright ドライバ(主経路)。
// LLM は介在しない。専用プロファイル(NOTEBOOKLM_PROFILE_DIR)に手動ログイン済みであることが前提。
// セレクタ不一致は ui_mismatch として返し、呼び出し側(pipeline)が claude --chrome へフォールバックする。

export type NotebookLmFailureKind =
  | "signed_out"
  | "ui_mismatch"
  | "nblm_unavailable"
  | "generation_failed"
  | "timeout"
  | "unreachable";

export type DriverFailure = {
  kind: NotebookLmFailureKind;
  detail: string;
  screenshotPath?: string;
};

export type DriverResult<T> = { ok: true; value: T } | { ok: false; failure: DriverFailure };

export type ArtifactSnapshotItem = {
  /** artifact-labels-<uuid> から抽出した UUID。取れない項目は null。 */
  id: string | null;
  /** 生成中/失敗の表示判定に使う項目テキスト(先頭300字)。 */
  text: string;
};

export type ArtifactSnapshot = {
  studioFound: boolean;
  items: ArtifactSnapshotItem[];
};

const GENERATING_TEXT = /(生成中|作成中|処理中)/;
const GENERATION_FAILED_TEXT = /(生成に失敗|生成エラー)/;
/** Step3 トリガ後に新規デックが一度も現れない場合の再確認回数(初回チェック+この回数で打ち切り)。 */
export const NEW_ARTIFACT_APPEAR_RETRIES = 3;
const UNAVAILABLE_TEXT = /現在、?回答できません/;

export const NBLM_SOURCE_NAMES = ["step1-output", "step2-output"] as const;

// セレクタは全てここに集約する(UI変更時の修理箇所を1箇所にする)。
// 候補配列は先頭から順に試す。probe(notebooklm:probe)が照合結果を表示する。
export const NBLM_SELECTORS = {
  /** ログイン済みノートブック画面に必ず存在する要素の候補(いずれか可視で signed_in)。 */
  signedInIndicators: ['[role="tab"]', "artifact-library-item", "textarea"],
  /** チャット入力欄の候補。 */
  chatInput: ['textarea[aria-label]', "textarea[placeholder]", "textarea"],
  /** チャット送信ボタンの候補。どれも無ければ Enter 送信にフォールバック。 */
  chatSubmit: ['button[aria-label*="送信"]', 'button[aria-label*="Submit"]', 'button[type="submit"]'],
  /** Drive 同期ボタンのテキスト。 */
  driveSyncText: /Google\s?ドライブと同期/,
  /** Studio タブのテキスト(role=tab または button)。 */
  studioTabText: "Studio"
} as const;

export function notebookUrl(notebookId: string): string {
  return `https://notebooklm.google.com/notebook/${notebookId}`;
}

export function artifactUrl(notebookId: string, artifactId: string): string {
  return `https://notebooklm.google.com/notebook/${notebookId}/artifact/${artifactId}`;
}

/** スナップショット差分から新規 artifact を抽出する(純粋関数・テスト対象)。 */
export function diffNewArtifacts(before: string[], after: ArtifactSnapshotItem[]): ArtifactSnapshotItem[] {
  const beforeSet = new Set(before.map((id) => id.toLowerCase()));
  return after.filter((item) => item.id !== null && !beforeSet.has(item.id.toLowerCase()));
}

/** artifact 項目テキストから生成状態を判定する(純粋関数・テスト対象)。 */
export function classifyArtifactItem(item: ArtifactSnapshotItem): "ready" | "generating" | "generation_failed" {
  if (GENERATION_FAILED_TEXT.test(item.text)) return "generation_failed";
  if (GENERATING_TEXT.test(item.text)) return "generating";
  return "ready";
}

type OpenSessionInput = {
  notebookId: string;
  /** 失敗スクリーンショットの保存先(ジョブフォルダ等)。 */
  jobDir: string;
  logger?: (message: string) => void;
};

export class NotebookLmSession {
  constructor(
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly notebookId: string,
    private readonly jobDir: string,
    private readonly log: (message: string) => void
  ) {}

  /**
   * ソース(step1-output/step2-output)を順に開き、「Googleドライブと同期」が出れば実行する。
   * 同期ボタンが30秒以内に出なければ「更新なし」とみなして先へ進む。
   *
   * 各ソースは毎回ノートブックURLへ再ナビゲートした初期状態(一覧が見える)から開く。
   * ソースを開くとソースガイド(source-viewer)が一覧を覆い、閉じるボタンでは一覧へ確実に
   * 戻れない(実DOM検証済み)ため、再ナビゲートでリセットするのが最も確実。
   */
  async syncSources(): Promise<DriverResult<void>> {
    for (const name of NBLM_SOURCE_NAMES) {
      const ready = await this.gotoSourceList();
      if (!ready.ok) return ready;

      const item = this.page.getByText(name, { exact: true }).first();
      try {
        await item.click({ timeout: 20_000 });
      } catch {
        return this.fail("ui_mismatch", `ソース「${name}」が見つかりません`, "sync-sources");
      }
      // ソースを開くとソースガイド(source-viewer)が開く。同期ボタンはこの中に出る。
      const syncButton = this.page.getByText(NBLM_SELECTORS.driveSyncText).first();
      const appeared = await syncButton.waitFor({ state: "visible", timeout: 30_000 }).then(
        () => true,
        () => false
      );
      if (appeared) {
        this.log(`NotebookLM: ソース「${name}」を Drive 同期します`);
        try {
          await syncButton.click({ timeout: 10_000 });
          await syncButton.waitFor({ state: "hidden", timeout: 120_000 });
        } catch {
          return this.fail("ui_mismatch", `ソース「${name}」の Drive 同期が完了しません`, "sync-sources");
        }
      } else {
        this.log(`NotebookLM: ソース「${name}」に同期ボタンなし(更新なしとみなす)`);
      }
    }
    return { ok: true, value: undefined };
  }

  /** ノートブックURLへ再ナビゲートし、ソース一覧(いずれかのソース名)が見える初期状態に戻す。 */
  private async gotoSourceList(): Promise<DriverResult<void>> {
    try {
      await this.page.goto(notebookUrl(this.notebookId), { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (error) {
      return this.fail("unreachable", `ノートブックの再読込に失敗: ${describeError(error)}`, "sync-sources");
    }
    const listed = await this.page
      .getByText(NBLM_SOURCE_NAMES[0], { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!listed) {
      return this.fail("ui_mismatch", "ソース一覧が表示されません", "sync-sources");
    }
    return { ok: true, value: undefined };
  }

  /** Studio の artifact 一覧(UUID+表示テキスト)を取得する。 */
  async snapshotArtifacts(): Promise<DriverResult<ArtifactSnapshot>> {
    let snapshot: ArtifactSnapshot;
    try {
      snapshot = (await this.page.evaluate(ARTIFACT_SNAPSHOT_SCRIPT)) as ArtifactSnapshot;
    } catch (error) {
      return this.fail("ui_mismatch", `Studio スナップショットの取得に失敗: ${describeError(error)}`, "snapshot");
    }
    if (!snapshot || !Array.isArray(snapshot.items)) {
      return this.fail("ui_mismatch", "Studio スナップショットの形式が不正です(スクリプト評価結果が空)", "snapshot");
    }
    if (!snapshot.studioFound && snapshot.items.length === 0) {
      return this.fail("ui_mismatch", "Studio タブも artifact 一覧も見つかりません", "snapshot");
    }
    return { ok: true, value: snapshot };
  }

  /**
   * チャットに「ステップ３を実行して」を送信する。送信後90秒だけ「現在、回答できません」を監視し、
   * 検出したら nblm_unavailable(呼び出し側が reload+再送でリトライ)。それ以外は成功として返す
   * (真の成功判定は Studio の新規 artifact 出現 = waitForNewArtifact が担う)。
   */
  async triggerStep3(message = "ステップ３を実行して"): Promise<DriverResult<void>> {
    const input = await this.firstVisible(NBLM_SELECTORS.chatInput);
    if (!input) {
      return this.fail("ui_mismatch", "チャット入力欄が見つかりません", "trigger-step3");
    }
    try {
      await input.fill(message, { timeout: 10_000 });
    } catch {
      return this.fail("ui_mismatch", "チャット入力欄に入力できません", "trigger-step3");
    }

    const submit = await this.firstVisible(NBLM_SELECTORS.chatSubmit);
    try {
      if (submit) {
        await submit.click({ timeout: 10_000 });
      } else {
        await input.press("Enter", { timeout: 10_000 });
      }
    } catch {
      return this.fail("ui_mismatch", "チャットを送信できません", "trigger-step3");
    }
    this.log("NotebookLM: Step3 トリガを送信しました");

    const unavailable = await this.watchUnavailable(90_000);
    if (unavailable) {
      return this.fail("nblm_unavailable", "NotebookLM が回答不能応答を返しました(現在、回答できません)", "trigger-step3");
    }
    return { ok: true, value: undefined };
  }

  /**
   * トリガ前スナップショットとの差分で新規デックの完成を待つ。
   * - MANGA_DECK_POLL_INTERVAL_MS ごとに reload + スナップショット
   * - MANGA_DECK_COMPLETE_TIMEOUT_MS 超過で timeout
   * - 新規デックが一度も現れないまま初回+NEW_ARTIFACT_APPEAR_RETRIES 回の確認を
   *   使い切ったら generation_failed(Step3 トリガが効いていないのに全体タイムアウト
   *   まで待ち続けない)。生成中デックが見えている間は全体タイムアウトまで待つ。
   * - beforeIds が空(旧ジョブの resume)は最上位 artifact を対象にする(旧挙動フォールバック)
   */
  async waitForNewArtifact(beforeIds: string[]): Promise<DriverResult<string>> {
    const deadline = Date.now() + config.manga.deckCompleteTimeoutMs;
    const legacyMode = beforeIds.length === 0;
    let emptyChecks = 0;

    for (;;) {
      const snapshotResult = await this.snapshotArtifacts();
      if (!snapshotResult.ok) return snapshotResult;

      const candidates = legacyMode
        ? snapshotResult.value.items.filter((item) => item.id !== null).slice(0, 1)
        : diffNewArtifacts(beforeIds, snapshotResult.value.items);

      const failed = candidates.find((item) => classifyArtifactItem(item) === "generation_failed");
      if (failed) {
        return this.fail("generation_failed", `デック生成に失敗しています: ${failed.text.slice(0, 200)}`, "deck-wait");
      }
      const ready = candidates.find((item) => classifyArtifactItem(item) === "ready");
      if (ready?.id) {
        return { ok: true, value: artifactUrl(this.notebookId, ready.id) };
      }

      // チャット側が後から「回答できません」を出すケースを検出し、無駄な40分待機を避ける。
      if (candidates.length === 0 && (await this.isUnavailableVisible())) {
        return this.fail("nblm_unavailable", "NotebookLM が回答不能応答を返しました(現在、回答できません)", "deck-wait");
      }

      if (candidates.length === 0) {
        emptyChecks += 1;
        if (emptyChecks > NEW_ARTIFACT_APPEAR_RETRIES) {
          return this.fail(
            "generation_failed",
            `Step3 トリガ後も新規デックが出現しません(${NEW_ARTIFACT_APPEAR_RETRIES}回再確認)`,
            "deck-wait"
          );
        }
      } else {
        // 生成中デックが見えたら未出現カウントを戻す(以降は全体タイムアウトが上限)。
        emptyChecks = 0;
      }

      if (Date.now() >= deadline) {
        return this.fail(
          "timeout",
          `デック生成が ${Math.round(config.manga.deckCompleteTimeoutMs / 60_000)} 分以内に完了しませんでした`,
          "deck-wait"
        );
      }

      this.log(
        candidates.length > 0
          ? "NotebookLM: デック生成中。待機して再確認します"
          : `NotebookLM: 新規デック未出現。待機して再確認します (${emptyChecks}/${NEW_ARTIFACT_APPEAR_RETRIES})`
      );
      await sleep(config.manga.deckPollIntervalMs);
      const reloaded = await this.reload();
      if (!reloaded.ok) return reloaded;
    }
  }

  /** ページを再読込し、ノートブック画面へ戻ったことを確認する(チャット再送リトライ用)。 */
  async reload(): Promise<DriverResult<void>> {
    try {
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (error) {
      return this.fail("unreachable", `ページ再読込に失敗: ${describeError(error)}`, "reload");
    }
    const state = await waitForNotebookState(this.page);
    if (state !== "signed_in") {
      return this.fail(state === "signed_out" ? "signed_out" : "ui_mismatch", "再読込後にノートブック画面へ戻れません", "reload");
    }
    return { ok: true, value: undefined };
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
  }

  private async isUnavailableVisible(): Promise<boolean> {
    return this.page
      .getByText(UNAVAILABLE_TEXT)
      .last()
      .isVisible()
      .catch(() => false);
  }

  /** timeoutMs の間、5秒間隔で「現在、回答できません」の出現を監視する。 */
  private async watchUnavailable(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isUnavailableVisible()) return true;
      await sleep(5_000);
    }
    return false;
  }

  private async firstVisible(candidates: readonly string[]): Promise<Locator | undefined> {
    for (const selector of candidates) {
      const locator = this.page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    return undefined;
  }

  private async fail(kind: NotebookLmFailureKind, detail: string, step: string): Promise<DriverResult<never>> {
    const screenshotPath = path.join(this.jobDir, `nblm-${step}-fail.png`);
    const saved = await this.page
      .screenshot({ path: screenshotPath, fullPage: false })
      .then(() => true)
      .catch(() => false);
    this.log(`NotebookLM: 失敗 [${kind}] ${detail}`);
    return { ok: false, failure: { kind, detail, ...(saved ? { screenshotPath } : {}) } };
  }
}

/**
 * 専用プロファイルで Chrome を起動し、ノートブックを開いてログイン状態を確認する。
 * 成功時は NotebookLmSession を返す。失敗時もコンテキストは閉じて返す。
 */
export async function openNotebookLmSession(input: OpenSessionInput): Promise<DriverResult<NotebookLmSession>> {
  const log = input.logger ?? (() => {});
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.notebookLm.profileDir, {
      channel: "chrome",
      headless: config.notebookLm.headless,
      viewport: { width: 1440, height: 900 },
      // 自動操作バナー/フラグを外し、Google ログインセッションの拒否リスクを下げる。
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"]
    });
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "unreachable",
        detail:
          `Chrome(専用プロファイル)の起動に失敗: ${describeError(error)}。` +
          "別プロセスが同じプロファイルを使用中の可能性があります"
      }
    };
  }

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(notebookUrl(input.notebookId), { waitUntil: "domcontentloaded", timeout: 60_000 });
    const state = await waitForNotebookState(page);
    if (state !== "signed_in") {
      const detail =
        state === "signed_out"
          ? "Google 未ログインです。`npm run notebooklm:login` でログインしてください"
          : "ノートブック画面を確認できません(UI変更または読み込み失敗)";
      const screenshotPath = path.join(input.jobDir, "nblm-open-fail.png");
      const saved = await page
        .screenshot({ path: screenshotPath })
        .then(() => true)
        .catch(() => false);
      await context.close().catch(() => {});
      return {
        ok: false,
        failure: {
          kind: state === "signed_out" ? "signed_out" : "ui_mismatch",
          detail,
          ...(saved ? { screenshotPath } : {})
        }
      };
    }
    log(`NotebookLM: ノートブックを開きました (${notebookUrl(input.notebookId)})`);
    return { ok: true, value: new NotebookLmSession(context, page, input.notebookId, input.jobDir, log) };
  } catch (error) {
    await context.close().catch(() => {});
    return { ok: false, failure: { kind: "unreachable", detail: `NotebookLM へ到達できません: ${describeError(error)}` } };
  }
}

/**
 * ログイン状態の判定: accounts.google.com へのリダイレクト = signed_out、
 * ノートブック UI 要素の可視 = signed_in、どちらも30秒以内に確認できなければ unknown。
 */
export async function waitForNotebookState(page: Page): Promise<"signed_in" | "signed_out" | "unknown"> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/accounts\.google\.com|ServiceLogin/i.test(url)) {
      return "signed_out";
    }
    for (const selector of NBLM_SELECTORS.signedInIndicators) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) {
        return "signed_in";
      }
    }
    await sleep(1_000);
  }
  return "unknown";
}

// ブラウザ内で実行する Studio スナップショット採取。セレクタ知見は実証済みの
// MANGA_DECK_DOM_SCRIPT(mangaDeckUrlFetcher.ts)から移植。
// page.evaluate(string) は文字列を「式」として評価するため、関数定義のままだと呼び出されず
// undefined が返る。必ず IIFE `(async () => {...})()` にして結果(Promise)を返す。
export const ARTIFACT_SNAPSHOT_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

  // 現行 NotebookLM の Studio は常時表示の studio-panel(artifact-library)。
  // タブ切替は無い(role=tab は存在しない)。旧UI互換として「Studio」タブがあれば1度だけ押す。
  const studioTab = [...document.querySelectorAll('[role="tab"], button')]
    .find((tab) => tab.textContent?.trim() === "Studio");
  if (studioTab && studioTab.getAttribute("aria-selected") === "false") {
    studioTab.click();
  }

  // artifact はナビゲーション直後に描画が遅れることがあるため、タブの有無に関係なくポーリングする。
  let items = [];
  let studioFound = Boolean(document.querySelector("studio-panel, artifact-library") || studioTab);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (document.querySelector("studio-panel, artifact-library")) studioFound = true;
    items = [...document.querySelectorAll("artifact-library-item")];
    if (items.length > 0) {
      studioFound = true;
      break;
    }
    await sleep(250);
  }

  return {
    studioFound,
    items: items.map((item) => {
      const labelled = item.querySelector('[aria-labelledby^="artifact-labels-"]');
      const match = (labelled?.getAttribute("aria-labelledby") ?? "")
        .match(new RegExp("^artifact-labels-(" + uuid + ")$", "i"));
      return {
        id: match ? match[1] : null,
        text: (item.textContent ?? "").trim().slice(0, 300)
      };
    })
  };
})()`;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
