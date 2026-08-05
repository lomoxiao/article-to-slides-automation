import { z } from "zod";
import type { MotionMode } from "./motionTypes.js";

const forbiddenValue = /<\/?(?:script|iframe|object|embed|html)|(?:https?:\/\/)|(?:\.\.[/\\])|(?:[A-Za-z]:\\)|(?:\$\()|(?:`)/i;
const safeText = (minimum: number, maximum: number) =>
  z.string().min(minimum).max(maximum).refine((value) => !forbiddenValue.test(value), "unsafe text");
const itemList = z.array(safeText(2, 32)).min(2).max(4);

export const visualSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("title"), keywords: z.array(safeText(2, 20)).min(2).max(3) }),
  z.object({ kind: z.literal("keypoints"), items: itemList }),
  z.object({ kind: z.literal("steps"), items: itemList }),
  z.object({ kind: z.literal("summary"), items: itemList }),
  z.object({
    kind: z.literal("compare"),
    left: z.object({ label: safeText(1, 18), items: z.array(safeText(2, 28)).min(1).max(3) }),
    right: z.object({ label: safeText(1, 18), items: z.array(safeText(2, 28)).min(1).max(3) })
  }),
  z.object({ kind: z.literal("number"), value: safeText(1, 12), label: safeText(2, 32) }),
  z.object({ kind: z.literal("quote"), text: safeText(4, 60) })
]);

export const videoSceneSchema = z.object({
  narration: safeText(1, 120),
  captionPhrases: z.array(safeText(8, 32)).min(1).max(3),
  screenText: safeText(4, 40),
  supportingText: safeText(15, 60),
  visual: visualSpecSchema,
  evidence: safeText(1, 300)
}).superRefine((scene, ctx) => {
  if (normalizeCaptionText(scene.captionPhrases.join("")) !== normalizeCaptionText(scene.narration)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["captionPhrases"], message: "captionPhrases must concatenate to narration" });
  }
});

export const videoPlanSchema = z.object({
  schemaVersion: z.literal(2),
  title: safeText(1, 100),
  scenes: z.array(videoSceneSchema).min(6).max(8)
}).superRefine((plan, ctx) => {
  const total = countNarrationChars(plan.scenes.map((scene) => scene.narration).join(""));
  if (total < 240 || total > 380) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `narration total must be 240-380 characters; got ${total}` });
  }
});

export type VideoPlan = z.infer<typeof videoPlanSchema>;
export type VideoScene = z.infer<typeof videoSceneSchema>;
export type VisualSpec = z.infer<typeof visualSpecSchema>;
export const captionCueSchema = z.object({
  id: z.string().min(1),
  sceneIndex: z.number().int().nonnegative(),
  text: safeText(1, 80),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive()
}).refine((cue) => cue.endMs > cue.startMs, "caption cue must have a positive interval");

export type CaptionCue = z.infer<typeof captionCueSchema>;
export type VideoStatus = "pending" | "processing" | "action_required" | "completed" | "failed";
export type VideoStage = "video_queued" | "video_planning" | "video_tts" | "video_captioning" | "video_transcribing" | "video_rendering" | "video_uploading";
export type VideoArtifactKind = "mp4" | "projectArchive" | "manifest";
export type VideoExecutionMode = "managed" | "cli";

export type VideoJob = {
  id: string;
  url: string;
  sourceText?: string;
  sourceTitle?: string;
  audience?: string;
  focus?: string;
  motionMode?: MotionMode;
  motionModeUsed?: MotionMode;
  motionFallbackReason?: string;
  requestedBy?: string;
  sourceChannelId?: string;
  executionMode?: VideoExecutionMode;
  inputHash: string;
  status: VideoStatus;
  stage: VideoStage;
  createdAt: string;
  updatedAt: string;
  jobDir: string;
  driveFolderId?: string;
  mp4FileId?: string;
  projectArchiveFileId?: string;
  manifestFileId?: string;
  createPending?: Partial<Record<VideoArtifactKind, boolean>>;
  completedSteps?: string[];
  durationRecoveryAttempted?: boolean;
  durationSec?: number;
  sizeBytes?: number;
  errorCode?: string;
  error?: string;
};

export function countNarrationChars(value: string): number {
  return value.replace(/[\s*_`#>\-[\]()]/g, "").length;
}

export function normalizeCaptionText(value: string): string {
  return value.normalize("NFKC").replace(/\s/gu, "");
}
