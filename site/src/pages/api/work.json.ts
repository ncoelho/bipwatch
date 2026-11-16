import { canonicalName, loadAll, loadPeople } from '@bipwatch/data';
import { API_VERSION } from '../../lib/view.ts';
import { workItems } from '../../lib/work.ts';

// Open work across tracked BIPs: the same list /work/ renders, newest first.
// Static file at /api/work.json; additive to API version 1.
export function GET() {
  const today = new Date();
  const items = workItems(loadAll(), canonicalName(loadPeople()), today);
  const body = { api_version: API_VERSION, generated: today.toISOString().slice(0, 10), count: items.length, items };
  return new Response(JSON.stringify(body, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
