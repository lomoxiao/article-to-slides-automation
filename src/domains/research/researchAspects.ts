/** 深掘りの観点。Viewer の research-ask.js と同じ ID・表示名を持つ(変えるときは両方を直す)。 */
export const RESEARCH_ASPECTS = [
  { id: "related", label: "関連する記事", hint: "同じ話題を扱う他の記事・報道。共通点と違い" },
  { id: "reception", label: "世間の評価", hint: "専門家・業界・報道・利用者の受け止め。肯定的な見方と慎重な見方" },
  { id: "counter", label: "反対意見・懸念", hint: "批判、リスク、懸念点、反論" },
  { id: "evidence", label: "技術的な裏付け", hint: "技術的な根拠、論文、公式の資料、数値の裏付け" },
  { id: "followup", label: "その後の動き", hint: "記事の後に起きたこと、続報、今後の予定" },
  { id: "impact", label: "自分の仕事への影響", hint: "決済・カード・金融サービスの事業や企画にとっての意味" }
] as const;

export type ResearchAspectId = (typeof RESEARCH_ASPECTS)[number]["id"];

export const RESEARCH_ASPECT_IDS = RESEARCH_ASPECTS.map((aspect) => aspect.id) as [ResearchAspectId, ...ResearchAspectId[]];

export function aspectLabel(id: string): string {
  return RESEARCH_ASPECTS.find((aspect) => aspect.id === id)?.label ?? id;
}
