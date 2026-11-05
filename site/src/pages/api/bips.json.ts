import { loadAll } from '@bipwatch/data';
import { API_VERSION } from '../../lib/view.ts';

// Index of every BIP in the dataset. Static file at /api/bips.json.
export function GET() {
  const all = loadAll();
  const body = {
    api_version: API_VERSION,
    bips: all.map(({ bip, claims, needs }) => ({
      number: bip.number,
      title: bip.title,
      status: bip.status,
      layer: bip.layer,
      tracked: bip.bipwatch.tracked,
      category: bip.bipwatch.category ?? null,
      claims: claims.length,
      has_needs: needs !== null,
      href: `/api/bips/${bip.number}.json`,
    })),
  };
  return new Response(JSON.stringify(body, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
