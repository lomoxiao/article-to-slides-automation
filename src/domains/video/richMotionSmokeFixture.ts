import { motionPlanSchema, validateMotionPlanContract, type MotionPlan } from "./motionTypes.js";
import type { VideoPlan } from "./types.js";

export const RICH_MOTION_SMOKE_LABELS = [
  "記事", "図解", "音声",
  "根拠", "要点", "見出し", "画面",
  "読みの整形", "原文分割", "読み正規化", "音声生成",
  "汎用処理", "読みが不安定", "日本語解析", "自然な発音",
  "実尺計測", "字幕同期",
  "ナレーション", "意味単位", "字幕表示",
  "動画", "ローカル生成", "ドライブ保存", "ビューアー再生", "配信可能"
] as const;

export function createRichMotionSmokePlan(videoPlan: VideoPlan): MotionPlan {
  const plan = motionPlanSchema.parse({
    schemaVersion: 1,
    theme: "dark-cyan-v1",
    scenes: [
      {
        sceneIndex: 0,
        diagram: {
          kind: "topology",
          nodes: [item("記事"), item("図解", "accent"), item("音声", "positive")],
          edges: [{ from: 0, to: 1 }, { from: 1, to: 2 }]
        }
      },
      {
        sceneIndex: 1,
        diagram: {
          kind: "cause-effect",
          source: item("根拠", "accent"),
          paths: [item("要点"), item("見出し"), item("画面", "positive")]
        }
      },
      {
        sceneIndex: 2,
        diagram: {
          kind: "cycle",
          center: "読みの整形",
          steps: [item("原文分割"), item("読み正規化", "accent"), item("音声生成", "positive")]
        }
      },
      {
        sceneIndex: 3,
        diagram: {
          kind: "migration",
          before: { label: "汎用処理", items: ["読みが不安定"] },
          after: { label: "日本語解析", items: ["自然な発音"] }
        }
      },
      {
        sceneIndex: 4,
        diagram: {
          kind: "timeline",
          steps: [item("音声生成"), item("実尺計測", "accent"), item("字幕同期", "positive")]
        }
      },
      {
        sceneIndex: 5,
        diagram: {
          kind: "layers",
          layers: [item("ナレーション"), item("意味単位", "accent"), item("字幕表示", "positive")],
          focusIndex: 2
        }
      },
      {
        sceneIndex: 6,
        diagram: {
          kind: "gates",
          token: "動画",
          gates: [item("ローカル生成"), item("ドライブ保存"), item("ビューアー再生")],
          result: "配信可能"
        }
      }
    ]
  });
  validateMotionPlanContract(plan, videoPlan);
  return plan;
}

export function assertRichMotionSmokeTextPreserved(html: string): void {
  const missing = RICH_MOTION_SMOKE_LABELS.filter((label) => !html.includes(label));
  if (missing.length > 0) throw new Error(`Rich motion smoke lost UTF-8 labels: ${missing.join(", ")}`);
  if (/\?{2,}/.test(html)) throw new Error("Rich motion smoke contains repeated ASCII question marks");
}

function item(label: string, tone: "neutral" | "accent" | "positive" = "neutral") {
  return { label, tone };
}
