import { isoWeek, loadAll, loadPrStates, loadWeek, loadWeekly } from '@bipwatch/data';
import { API_VERSION, storyTile } from '../../lib/view.ts';

// The homepage's week as data, in the shape the page renders: the week's
// numbers and lists (null when the build had no archive), and the approved
// lead story with its tiles resolved. Static file at /api/week.json.
export function GET() {
  const now = new Date();
  const week = loadWeek();
  const story = loadWeekly(isoWeek(now)) ?? loadWeekly(isoWeek(new Date(now.getTime() - 7 * 86_400_000)));
  const b = story ? loadAll().find((x) => x.bip.number === story.bip) : undefined;
  const prs = loadPrStates();
  const body = {
    api_version: API_VERSION,
    week,
    lead_story: story && b ? { ...story, tiles: story.tiles.map((k) => ({ key: k, ...storyTile(k, b, prs) })) } : null,
  };
  return new Response(JSON.stringify(body, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
