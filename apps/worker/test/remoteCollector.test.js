import test from 'node:test';
import assert from 'node:assert/strict';
import {createRemoteCollector} from '../src/remoteCollector.js';
import {executeCollectorJob} from '../src/collectorAgent.js';
import {createFacebookConnector} from '../src/facebookConnector.js';

function memoryStore() {
  let settings={enabled:false};const jobs=new Map();
  return {jobs,
    async settings(){return {...settings};}, async settingsUpdate(value){Object.assign(settings,value);},
    async insert(job){jobs.set(job.id,{...job,status:'queued'});},
    async claim(){const job=[...jobs.values()].find(job=>job.status==='queued');if(!job)return null;job.status='running';return job;},
    async read(id){return jobs.get(id);},
    async finish(id,body){const job=jobs.get(id);if(!job || job.status!=='running')return false;Object.assign(job,{status:body.error?'failed':'completed',...body});return true;},
    async remove(id){jobs.delete(id);},async clear(){jobs.clear();},async cleanup(){}
  };
}

test('device enrollment hides credentials in status, can be rotated and revoked',async()=>{
  const store=memoryStore();let clock=1000;
  const broker=createRemoteCollector({store,now:()=>clock});
  const first=await broker.enroll();assert.equal(await broker.authenticate(first),true);
  assert.equal(await broker.authenticate('invalid'),false);
  assert.equal(JSON.stringify(await store.settings()).includes(first),false);
  assert.deepEqual(await broker.status(),{enabled:false,connected:false,lastSeen:null});
  await assert.rejects(broker.enable(true),/Start the collector/);
  await broker.heartbeat();await broker.enable(true);
  assert.equal((await broker.status()).connected,true);
  clock+=45001;assert.equal((await broker.status()).connected,false);
  const second=await broker.enroll();assert.equal(await broker.authenticate(first),false);assert.equal(await broker.authenticate(second),true);
  await broker.revoke();assert.equal(await broker.authenticate(second),false);assert.equal((await broker.status()).enabled,false);
});

test('remote search returns listings and diagnostics through the existing connector',async()=>{
  const store=memoryStore();let broker;let clock=1000;
  const worker={lastSearchInspection:{state:'finished',listingCount:1},async searchListings(params){assert.equal(params.query,'corvette');return {listings:[{id:'123',title:'2020 Chevrolet Corvette',price:'$50,000',url:'https://www.facebook.com/marketplace/item/123/'}],hasNextPage:false,diagnostics:{richListingCount:1}};}};
  broker=createRemoteCollector({store,now:()=>clock,sleep:async()=>{clock+=100;const job=await broker.poll();if(job)assert.equal(await broker.finish(job.id,await executeCollectorJob(worker,job)),true);}});
  await broker.enroll();await broker.heartbeat();await broker.enable(true);
  const routed=broker.routeClient({searchListings:()=>{throw new Error('Render must not contact Facebook.');}});
  const connector=createFacebookConnector({mode:'facebook_graphql',client:routed,maxCardsPerRun:25});
  const result=await connector.captureListingCards({query:'corvette',radiusMiles:100,filtersJson:{latitude:37.4,longitude:-121.9}});
  assert.equal(result.cards.length,1);assert.equal(result.cards[0].sourceItemId,'123');
  assert.equal(routed.lastSearchInspection.listingCount,1);assert.equal(store.jobs.size,0);
});

test('collector failures retain sanitized diagnostics and stop the request',async()=>{
  const store=memoryStore();let broker;
  const worker={session:{fbDtsg:'private-token'},async searchListings(){const error=new Error('Rate limit exceeded private-token');error.searchInspection={state:'failed',response:{errors:[{code:1675004}]}};throw error;}};
  broker=createRemoteCollector({store,now:()=>1000,sleep:async()=>{const job=await broker.poll();if(job)await broker.finish(job.id,await executeCollectorJob(worker,job));}});
  await broker.enroll();await broker.heartbeat();await broker.enable(true);
  const routed=broker.routeClient({});
  await assert.rejects(routed.searchListings({query:'corvette'}),error=>{assert.equal(error.message.includes('private-token'),false);assert.equal(error.searchInspection.response.errors[0].code,1675004);return true;});
  assert.equal(routed.lastSearchInspection.state,'failed');assert.equal(store.jobs.size,0);
});

test('offline and timeout requests fail without falling back or replaying Facebook calls',async()=>{
  const store=memoryStore();let clock=1000;let calls=0;
  const broker=createRemoteCollector({store,now:()=>clock,jobTimeoutMs:100,sleep:async()=>{clock+=101;}});
  const routed=broker.routeClient({searchListings:async()=>{calls++;}});
  await broker.enroll();await broker.heartbeat();await broker.enable(true);
  await assert.rejects(routed.searchListings({query:'corvette'}),/timed out/);assert.equal(store.jobs.size,0);
  clock+=45000;await assert.rejects(routed.searchListings({query:'corvette'}),/offline/);assert.equal(calls,0);
});

test('disabled routing uses the configured client and tracks its inspection',async()=>{
  const broker=createRemoteCollector({store:memoryStore()});
  const local={lastSearchInspection:{state:'finished'},searchListings:async()=>({listings:[]})};
  const routed=broker.routeClient(local);assert.deepEqual(await routed.searchListings({}),{listings:[]});assert.equal(routed.lastSearchInspection.state,'finished');
});

test('worker accepts only direct Facebook client operations',async()=>{
  let called=false;
  assert.deepEqual(await executeCollectorJob({anything:()=>{called=true;}},{operation:'anything',args:[]}),{error:{message:'Unsupported collector job.'}});
  assert.equal(called,false);
});
