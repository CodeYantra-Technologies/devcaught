import {readFileSync} from 'node:fs';
import {betterAuth} from 'better-auth';
import {tanstackStartCookies} from 'better-auth/tanstack-start';
import {Pool} from 'pg';
import {Kysely,PostgresDialect,sql} from 'kysely';
import {invitationAuthPolicy,invitationPlugin} from '../../../src/lib/auth/invitation-policy.ts';
import {AUTH_COOKIES,resolveTrustedOrigins} from '../../../src/lib/auth/auth-config.ts';
import {origin,validateManifest,signingMaterial} from '../profile.mjs';

export const manifest=JSON.parse(readFileSync('/manifest.json','utf8'));validateManifest(manifest);
if(process.env.DEVCAUGHT_PRIVATE_API_RUN!==manifest.run)throw new Error('Acceptance identity mismatch');
const connectionString=process.env.DATABASE_URL;
let url:URL;
try{url=new URL(connectionString??'');}catch{throw new Error('Acceptance PostgreSQL required');}
if(!['postgres:','postgresql:'].includes(url.protocol)||url.username!=='devcaught_auth_app')throw new Error('Acceptance app role required');
const pool=new Pool({connectionString,max:4,connectionTimeoutMillis:4000,statement_timeout:4000,
  query_timeout:5000,idle_in_transaction_session_timeout:5000,application_name:`private-api-${manifest.run}`});
pool.on('error',()=>{});
export const authDatabase=new Kysely<unknown>({dialect:new PostgresDialect({pool})});
export const authConfigured=true,authRequested=true;
export const auth=betterAuth({
  ...invitationAuthPolicy,database:{db:authDatabase,type:'postgres',transaction:true},
  secret:signingMaterial(manifest.run),baseURL:origin,trustedOrigins:resolveTrustedOrigins(origin),
  advanced:{useSecureCookies:false,defaultCookieAttributes:{secure:true,sameSite:'lax',path:'/'},
    cookies:AUTH_COOKIES,ipAddress:{ipAddressHeaders:[]}},
  plugins:[invitationPlugin(),tanstackStartCookies()],
});
export async function cancelled() {
  const {rows}=await sql<{cancelled:boolean}>`SELECT EXISTS (SELECT 1 FROM invitation WHERE id=${manifest.cancelled}) AS cancelled`.execute(authDatabase);
  return rows[0]?.cancelled!==false;
}
export async function checkRole() {
  const {rows}=await sql<{role:string}>`SELECT current_user AS role`.execute(authDatabase);
  if(rows[0]?.role!=='devcaught_auth_app')throw new Error('Acceptance app role required');
}
