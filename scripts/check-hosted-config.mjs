import { readFileSync } from 'node:fs';
const c=JSON.parse(readFileSync('wrangler.hosted.jsonc','utf8'));
const problems=[];
try {
 const url=new URL(c.vars.PUBLIC_ORIGIN);
 if(url.protocol!=='https:' || ['localhost','127.0.0.1'].includes(url.hostname) || url.origin!==c.vars.PUBLIC_ORIGIN)problems.push('PUBLIC_ORIGIN must be the canonical production HTTPS origin');
} catch {problems.push('PUBLIC_ORIGIN is required');}
if(!c.vars.TURNSTILE_SITE_KEY)problems.push('TURNSTILE_SITE_KEY is required');
if(!c.d1_databases?.[0]?.database_id || c.d1_databases[0].database_id==='00000000-0000-0000-0000-000000000000')problems.push('Set the dedicated hosted D1 database ID');
if(c.name!=='shotsync-hosted' || c.r2_buckets?.[0]?.bucket_name!=='shotsync-hosted')problems.push('Hosted Worker and bucket must remain separate from personal/demo instances');
if(problems.length){console.error(problems.join('\n'));process.exit(1);}
console.log('Hosted config ready. Confirm PASSWORD_PEPPER and Turnstile secrets, bucket lifecycle, and deployment authorization before publishing.');
