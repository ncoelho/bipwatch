import { loadAll, type BipBundle } from '@bipwatch/data';
import { toApi } from '../../../lib/view.ts';

// One static file per BIP at /api/bips/<number>.json: the same data the page renders.
export function getStaticPaths() {
  return loadAll().map((bundle) => ({ params: { number: String(bundle.bip.number) }, props: { bundle } }));
}

export function GET({ props }: { props: { bundle: BipBundle } }) {
  return new Response(JSON.stringify(toApi(props.bundle), null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}
