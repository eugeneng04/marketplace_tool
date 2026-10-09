import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
export const COLLECTOR_OPERATIONS = new Set(['searchListings', 'getListingDetail', 'searchLocation']);
const ONLINE_MS = 45000;
const JOB_MS = 120000;

export function createCollectorStore(db) {
  return {
    async settings() {
      return (await db.pool.query("SELECT value_json FROM app_settings WHERE key='remote_collector'")).rows[0]?.value_json ?? {enabled:false};
    },
    async settingsUpdate(value) {
      await db.pool.query(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('remote_collector',$1::jsonb,NOW())
        ON CONFLICT(key) DO UPDATE SET value_json=app_settings.value_json || EXCLUDED.value_json, updated_at=NOW()`, [JSON.stringify(value)]);
    },
    async insert(job) {
      await db.pool.query(`INSERT INTO collector_jobs(id,operation,args_json,expires_at) VALUES($1,$2,$3::jsonb,$4)`, [job.id,job.operation,JSON.stringify(job.args),new Date(job.expiresAt)]);
    },
    async claim() {
      // Claimed jobs are never replayed: an interrupted Facebook request must
      // be visible as failed rather than silently repeated from another agent.
      return (await db.pool.query(`UPDATE collector_jobs SET status='running' WHERE id=(
        SELECT id FROM collector_jobs WHERE status='queued' AND expires_at>NOW() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
      ) RETURNING id,operation,args_json AS args`)).rows[0] ?? null;
    },
    async read(id) { return (await db.pool.query('SELECT status,result_json AS result,error_json AS error FROM collector_jobs WHERE id=$1',[id])).rows[0]; },
    async finish(id,body) {
      return (await db.pool.query(`UPDATE collector_jobs SET status=$2,result_json=$3::jsonb,error_json=$4::jsonb
        WHERE id=$1 AND status='running' AND expires_at>NOW() RETURNING id`,[id,body.error?'failed':'completed',JSON.stringify(body.result??null),JSON.stringify(body.error??null)])).rowCount === 1;
    },
    async remove(id) {await db.pool.query('DELETE FROM collector_jobs WHERE id=$1',[id]);},
    async clear() {await db.pool.query('DELETE FROM collector_jobs');},
    async cleanup() {await db.pool.query('DELETE FROM collector_jobs WHERE expires_at < NOW()');}
  };
}

export function createRemoteCollector({store, now=Date.now, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)), jobTimeoutMs=JOB_MS}) {
  async function status() {
    const value=await store.settings();
    return {enabled:Boolean(value.enabled), connected:Boolean(value.lastSeen && now()-value.lastSeen<ONLINE_MS), lastSeen:value.lastSeen?new Date(value.lastSeen).toISOString():null};
  }
  async function authenticate(token) {
    const expected=(await store.settings()).tokenHash;
    return Boolean(expected && typeof token==='string' && timingSafeEqual(Buffer.from(hash(token)),Buffer.from(expected)));
  }
  async function enroll() {
    const token=randomBytes(32).toString('hex');
    await store.clear();
    await store.settingsUpdate({tokenHash:hash(token),enabled:false,lastSeen:null});
    return token;
  }
  async function enable(enabled) {
    if(enabled && !(await status()).connected) throw new Error('Start the collector on your computer before enabling it.');
    await store.settingsUpdate({enabled});
    return status();
  }
  async function poll() {
    await store.settingsUpdate({lastSeen:now()});
    await store.cleanup();
    return store.claim();
  }
  async function heartbeat(retryAt = 0) {
    const value=Number(retryAt);
    await store.settingsUpdate({lastSeen:now(), retryAt:Number.isFinite(value) && value>now() && value<now()+86400000 ? value : 0});
  }
  async function facebookStatus() {
    const value=await store.settings();
    return {source:'computer',paused:Number(value.retryAt)>now(),retryAt:Number(value.retryAt)>now()?new Date(value.retryAt).toISOString():null};
  }
  async function revoke() {await store.settingsUpdate({enabled:false,tokenHash:null,lastSeen:null});await store.clear();}
  async function request(operation,args) {
    if(!COLLECTOR_OPERATIONS.has(operation)) throw new Error('Unsupported collector operation.');
    const current=await status();
    if(!current.connected) throw new Error('Computer collector is offline. Start it and keep the computer awake, then retry.');
    const id=randomUUID();
    await store.insert({id,operation,args,expiresAt:now()+jobTimeoutMs});
    const deadline=now()+jobTimeoutMs;
    try {
      while(now()<deadline) {
        const job=await store.read(id);
        if(job?.status==='completed') return job.result;
        if(job?.status==='failed') {
          const error=new Error(job.error?.message??'Computer collector request failed.');
          if(job.error?.code==='FACEBOOK_COOLDOWN') {error.code=job.error.code;error.retryAt=job.error.retryAt;}
          if(job.error?.name==='ListingDetailUnavailableError') error.name=job.error.name;
          if(job.error?.detailDiagnostic) error.facebookDetailDiagnostic=job.error.detailDiagnostic;
          if(job.error?.inspection) error.searchInspection=job.error.inspection;
          throw error;
        }
        await sleep(1000);
      }
      throw new Error('Computer collector timed out. The request was not automatically retried.');
    } finally {await store.remove(id);}
  }
  function routeClient(local) {
    const routed={lastSearchInspection:null};
    for(const operation of COLLECTOR_OPERATIONS) routed[operation]=async (...args)=>{
      if(!(await status()).enabled) {
        try {return await local[operation](...args);}
        finally {if(operation==='searchListings') routed.lastSearchInspection=local.lastSearchInspection;}
      }
      try {
        const payload=await request(operation,args);
        if(operation==='searchListings') routed.lastSearchInspection=payload.inspection;
        return payload.value;
      } catch(error) {if(error.searchInspection) routed.lastSearchInspection=error.searchInspection;throw error;}
    };
    return routed;
  }
  return {status,authenticate,enroll,enable,poll,heartbeat,facebookStatus,revoke,request,routeClient,finish:store.finish};
}
