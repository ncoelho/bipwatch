import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://bipwatch.com',
  output: 'static',
  trailingSlash: 'ignore',
  vite: {
    // The data package ships TypeScript source; let Vite compile it.
    ssr: { noExternal: ['@bipwatch/data'] },
  },
});
