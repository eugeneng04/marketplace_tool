import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {FacebookGraphqlClient} from './facebookGraphqlClient.js';
import {createFacebookRequestLimiter} from './facebookRequestLimiter.js';
import {sanitizeFacebookEvidence} from './facebookSearchInspection.js';
import {COLLECTOR_OPERATIONS} from './remoteCollector.js';

export async function executeCollectorJob(client,job) {
  if(!COLLECTOR_OPERATIONS.has(job.operation) || !Array.isArray(job.args)) return {error:{message:'Unsupported collector job.'}};
  try {
    const value=await client[job.operation](...job.args);
    return {result:{value, ...(job.operation==='searchListings'?{inspection:client.lastSearchInspection}: {})}};
  } catch(error) {
    return {error:{message:sanitizeFacebookEvidence(error.message,client.session??{}),
      ...(error.code==='FACEBOOK_COOLDOWN'?{code:error.code,retryAt:error.retryAt}: {}),
      ...(error.name==='ListingDetailUnavailableError'?{name:error.name}: {}),
      ...(error.facebookDetailDiagnostic?{detailDiagnostic:error.facebookDetailDiagnostic}: {}),
      ...(error.searchInspection?{inspection:error.searchInspection}: {})}};
  }
}

export async function runCollectorAgent({configPath,signal,fetchImpl=fetch}) {
  const file=resolve(configPath);
  const config=JSON.parse(await readFile(file,'utf8'));
  const url=new URL(config.appUrl);
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('Collector appUrl must be an HTTPS origin.');
  if(!/^[a-f0-9]{64}$/.test(config.token??'')) throw new Error('Invalid collector credential file.');
  const cooldownFile=resolve(dirname(file),'.collector-cooldown.json');
  const store={
    async readBackoff(){try{return JSON.parse(await readFile(cooldownFile,'utf8'));}catch(error){if(error.code==='ENOENT')return {};throw error;}},
    async read(){return Number((await this.readBackoff()).until)||0;},
    async write(until,backoff){await mkdir(dirname(cooldownFile),{recursive:true});await writeFile(`${cooldownFile}.tmp`,JSON.stringify({until,...backoff}),{mode:0o600});await rename(`${cooldownFile}.tmp`,cooldownFile);}
  };
  // Never extracts a browser session. Facebook credentials stay separate from
  // the application device credential and are not part of this protocol.
  const client=new FacebookGraphqlClient({useChromeCookies:false,facebookCookie:'',scheduleRequest:createFacebookRequestLimiter({store})});
  async function api(path,body) {
    const response=await fetchImpl(`${url.origin}${path}`,{method:'POST',headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json'},body:JSON.stringify(body??{}),redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok) {const error=new Error(`Collector API returned HTTP ${response.status}.`);error.status=response.status;throw error;}
    return response.json();
  }
  const sleep=ms=>new Promise(resolve=>{const timer=setTimeout(done,ms);function done(){clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();}signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();});
  const heartbeat=setInterval(()=>{void store.read().then(retryAt=>api('/collector/heartbeat',{retryAt})).catch(()=>{});},15000);
  console.log('HTTP collector started. Keep this computer awake. Facebook cookies are not read.');
  try {
    while(!signal?.aborted) {
      try {
        const {job}=await api('/collector/poll');
        if(job) {
          const result=await executeCollectorJob(client,job);
          await api('/collector/heartbeat',{retryAt:await store.read()});
          await api(`/collector/jobs/${encodeURIComponent(job.id)}`,result);
          console.log(`${job.operation}: ${result.error?'failed':'completed'}`);
        } else await sleep(5000);
      } catch(error) {
        if(error.status===401) throw new Error('Collector authorization expired. Download a new connection file from the app.');
        console.error(error.status?`Collector connection returned HTTP ${error.status}.`:'Collector connection interrupted; reconnecting.');
        await sleep(10000);
      }
    }
  } finally {clearInterval(heartbeat);}
}

if(import.meta.url===`file://${process.argv[1]}`) {
  const configPath=process.argv[process.argv.indexOf('--config')+1];
  if(!process.argv.includes('--config') || !configPath) {console.error('Usage: node apps/worker/src/collectorAgent.js --config /path/to/resale-collector.json');process.exitCode=1;}
  else {
    const abort=new AbortController();
    process.on('SIGINT',()=>abort.abort());process.on('SIGTERM',()=>abort.abort());
    runCollectorAgent({configPath,signal:abort.signal}).catch(error=>{console.error(error.message);process.exitCode=1;});
  }
}
