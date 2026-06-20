/**
 * Pick the strongest available text: a trimmed primary value, else a trimmed
 * existing value, else the fallback. Used so that a re-registration never
 * overwrites a good title/headline with a weaker (empty / host-only) one.
 *
 * NOTE: multimodalArticleRegistry.ts still has a private copy of this logic;
 * it will be unified to import from here in Phase 4 (kept duplicated for now to
 * avoid re-touching Phase 1 code).
 */
export function chooseText(primary: string | undefined, existing: string | undefined, fallback: string): string {
  const primaryTrimmed = primary?.trim();
  if (primaryTrimmed) {
    return primaryTrimmed;
  }
  const existingTrimmed = existing?.trim();
  if (existingTrimmed) {
    return existingTrimmed;
  }
  return fallback;
}
