import {defineConfig} from 'vite';

// Standalone server bundle only: no application plugins, bootstrap or env loader.
export default defineConfig({
  publicDir:false,
  build:{
    target:'node22', outDir:'ingestion-build', emptyOutDir:false, minify:false,
    lib:{entry:'apps/server/src/index.ts',formats:['es'],fileName:()=> 'ingestion.mjs'},
    rollupOptions:{external:id=>!id.startsWith('.') && !id.startsWith('/'),output:{chunkFileNames:'[name]-[hash].mjs'}},
  },
});
