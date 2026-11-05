import { loadFreshness } from '@bipwatch/data';
import { API_VERSION } from '../../lib/view.ts';

// When each collector last succeeded. Static file at /api/freshness.json;
// `sources` is empty when the build had no database to read from.
export function GET() {
  const f = loadFreshness();
  const body = {
    api_version: API_VERSION,
    generated_at: f?.generated_at ?? null,
    sources: f?.sources ?? [],
  };
  return new Response(JSON.stringify(body, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
