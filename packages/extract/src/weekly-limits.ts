// Length limits for the weekly lead story, from data/schemas/weekly.schema.json.
// The model is told them and asked again when it overshoots; clip() is the
// last resort so a long draft never fails the validator and loses the week.
export const HEADLINE_MAX = 160;
export const LEAD_MAX = 400;

/** Text at most `max` characters: whole sentences when one fits, else whole words and "…". */
export function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const end = Math.max(...['. ', '! ', '? '].map((p) => head.lastIndexOf(p)));
  if (end > 0) return head.slice(0, end + 1);
  const words = t.slice(0, max - 1);
  const cut = words.lastIndexOf(' ');
  return `${(cut > 0 ? words.slice(0, cut) : words).replace(/[,;:\s]+$/, '')}…`;
}

/** True when the draft fits the schema. */
export const fits = (o: { headline: string; lead: string }) => o.headline.trim().length <= HEADLINE_MAX && o.lead.trim().length <= LEAD_MAX;
