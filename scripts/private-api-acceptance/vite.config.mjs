import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
import {tanstackStart} from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import {nitro} from 'nitro/vite';

const path=name=>fileURLToPath(new URL(name,import.meta.url));
const allowedAuth=new Set(['auth-config.ts','invitation-policy.ts','invitations.ts','private-inbox.ts',
  'session-policy.ts','private-inbox.server.ts','verify.server.ts','http-handler.ts']
  .map(name=>path('../../src/lib/auth/'+name)));
// The only substitution is the auth singleton's connection/configuration, not
// the request/session resolver or release guard. Missing matches fail the build:
// the production auth singleton is intentionally absent from the context.
export default defineConfig({
  envDir:false,
  plugins:[{
    name:'isolated-auth-singleton',enforce:'pre',
    resolveId(source,importer) {
      const file=importer?.split('?')[0];
      if(['./server','./server.ts'].includes(source)&&
        [path('../../src/lib/auth/private-inbox.server.ts'),path('../../src/lib/auth/verify.server.ts')].includes(file)) {
        return path('./app/auth.server.ts');
      }
    },
    load(id) {
      const file=id.split('?')[0];
      // Also fail before Vite can load unexpected source inherited from a base
      // image, even if a future resolver import no longer matches the alias.
      if(file.startsWith(path('../../src/lib/auth/'))&&!allowedAuth.has(file)) {
        throw new Error('Auth module outside acceptance build allowlist');
      }
    },
  // Start joins srcDirectory to the Vite root, so it must be root-relative.
  },tanstackStart({srcDirectory:'scripts/private-api-acceptance/app',router:{routesDirectory:path('./app/routes'),
    generatedRouteTree:path('./app/routeTree.gen.ts'),disableLogging:true}}),
  nitro({preset:'node-server',serverDir:false,scanDirs:[],plugins:[]}),react()],
});
