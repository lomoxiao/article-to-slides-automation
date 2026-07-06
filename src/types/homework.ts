import { z } from "zod";

export const homeworkProblemAnalysisSchema = z.object({
  id: z.string().min(1),
  problemText: z.string().min(1),
  studentAnswer: z.string().min(1),
  correctAnswerCandidate: z.string().min(1),
  mistakeCause: z.string().min(1),
  confidence: z.object({
    problemText: z.number().min(0).max(1),
    studentAnswer: z.number().min(0).max(1),
    correctAnswerCandidate: z.number().min(0).max(1),
    mistakeCause: z.number().min(0).max(1)
  }),
  evidence: z.array(z.string()),
  warnings: z.array(z.string())
});

export const homeworkAnalysisSchema = z.object({
  problems: z.array(homeworkProblemAnalysisSchema).min(1),
  warnings: z.array(z.string()),
  needsHumanReview: z.literal(true)
}).transform((analysis) => analysis.problems.length <= 10 ? analysis : ({
  ...analysis,
  problems: analysis.problems.slice(0, 10),
  warnings: [...analysis.warnings, "問題候補が10件を超えたため、最初の10件だけを表示しています。"]
}));

export type HomeworkAnalysis = z.infer<typeof homeworkAnalysisSchema>;
export type HomeworkProblemAnalysis = z.infer<typeof homeworkProblemAnalysisSchema>;
export type HomeworkJobStatus = "queued" | "downloading" | "analyzing" | "validating" | "review_required" | "scenario_queued" | "scenario_generating" | "scenario_validating" | "scenario_review_required" | "needs_review" | "unsupported" | "completed" | "failed" | "delete_requested" | "deleting" | "delete_failed";

export type HomeworkSourceImage = {
  provider: "google_drive";
  fileId: string;
  contentType: string;
  size: number;
  viewUrl: string;
  downloadUrl: string;
  displayUrl?: string;
};

export type HomeworkJob = {
  id: string;
  ownerUid: string;
  status: HomeworkJobStatus;
  stage: HomeworkJobStatus;
  trigger?: { provider: "web"; requestedBy: string; slackTriggerSentAt?: string };
  slack?: { channelId: string; messageTs: string; fileId: string; eventId?: string; userId?: string };
  sourceImage?: HomeworkSourceImage;
  analysis?: HomeworkAnalysis;
  approvedAnalysis?: Record<string, unknown>;
  solutionSteps?: Array<Record<string, unknown>>;
  verification?: { status: string; confidence: number; warnings: string[] };
  mangaPlan?: Record<string, unknown>;
  errors?: Array<{ code: string; panel: number | null; path: Array<string | number>; reason: string }>;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type SlackHomeworkFile = {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
  file_access?: string;
};
