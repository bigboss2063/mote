export interface CitationCheck {
  markdown: string;
  citedIds: number[];
}

/** Drop citation ids that were not in the prompt; keep the model's valid
 *  markers for rendering and collect a stable source list. */
export function validateCitations(markdown: string, validIds: Set<number>): CitationCheck {
  const cited = new Set<number>();
  const cleaned = markdown.replace(/\[(\d+)\]/g, (match, rawId: string) => {
    const id = Number(rawId);
    if (!validIds.has(id)) return "";
    cited.add(id);
    return match;
  });
  // Keep first-citation order so display sources can be numbered 1..N.
  return { markdown: cleaned, citedIds: [...cited] };
}
