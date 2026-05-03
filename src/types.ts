export type SourceContent = {
  url: string;
  title: string;
  author?: string;
  publishedAt?: string;
  text: string;
};

export type SlideOutline = {
  title: string;
  subtitle?: string;
  slides: Array<{
    layout?: SlideLayout;
    title: string;
    bullets: string[];
    speakerNotes?: string;
  }>;
};

export type SlideLayout =
  | "title"
  | "section"
  | "key_message"
  | "three_takeaways"
  | "comparison"
  | "process"
  | "risk_opportunity"
  | "summary";

export type GeneratedDeck = {
  presentationId: string;
  url: string;
};
