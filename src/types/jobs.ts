export type SlideJobStatus = "pending" | "processing" | "completed" | "failed";

export type SlideJob = {
  id: string;
  url?: string;
  urls?: string[];
  researchPrompt?: string;
  audience?: string;
  focus?: string;
  pages?: number;
  requestedBy?: string;
  sourceChannelId?: string;
  status: SlideJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  pendingDir: string;
  completedDir: string;
  slideDataPath?: string;
  deckUrl?: string;
  presentationId?: string;
  error?: string;
};

export type CreateSlideJobInput = {
  url?: string;
  urls?: string[];
  researchPrompt?: string;
  audience?: string;
  focus?: string;
  pages?: number;
  requestedBy?: string;
  sourceChannelId?: string;
};
