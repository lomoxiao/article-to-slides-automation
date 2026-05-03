export type SlideJobStatus = "pending" | "processing" | "completed" | "failed";

export type SlideJob = {
  id: string;
  url: string;
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
  url: string;
  requestedBy?: string;
  sourceChannelId?: string;
};
