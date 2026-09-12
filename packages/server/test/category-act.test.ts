import { expect, test, spyOn } from 'bun:test';
import { VariableStore, type ActContext } from '@ntnx-game/engine';
import { acts } from '../../../packs/ntnx-infiltration/acts';

async function scenario(first: 'SUCCEEDED' | 'scope' | 'denied' | 'unknown', bound = false) {
  const vars = new VariableStore();
  for (const [k,v] of Object.entries({Trigram:'rbo', PC:'https://pc.invalid', PCUser:'admin', PCPassword:'test'})) vars.set(k,v,1);
  const posts: Array<{url:string; body:any}> = [];
  let applied = bound;
  const ctx = {
    vars, session:{id:'s',trigram:'rbo',locale:'en',clusterProfile:'hpoc'},
    cache:{get(){},set(){},all(){return []}}, logger:{debug(){},info(){},warn(){},error(){}},
    nutanix: {mode:'live', sdk:{
      vmm:{vms:{async listVms(){return {data:{data:[{name:'rbo-vm',extId:'vm',categories:applied?[{extId:'cat'}]:[]}]}}}}},
      prism:{categories:{async listCategories(){return {data:{data:[{key:'rbo-cat',value:'Critical',extId:'cat'}]}}}}},
    },rest:{async request(_method:string,path:string){
      if(path.includes('/v3/vms/')) return {metadata:{project_reference:{uuid:'project'}}};
      if(!path.includes('/tasks/')) throw new Error(`Unexpected ${path}`);
      if(posts.length===1 && first==='unknown') throw new Error('task result unavailable');
      if(posts.length===1 && first!=='SUCCEEDED') return {data:{status:'FAILED',errorMessages:[{code:first==='scope'?'VMM-31701':'DENIED',message:'Rejected'}]}};
      if(posts.at(-1)?.url.endsWith('associate-categories')) applied=true;
      return {data:{status:'SUCCEEDED'}};
    }}},
  } as unknown as ActContext;
  const fetch = spyOn(globalThis,'fetch').mockImplementation(async (url,init) => {
    if(init?.method==='POST') posts.push({url:String(url),body:JSON.parse(String(init.body))});
    return new Response(JSON.stringify({data:{extId:'task'}}),{status:init?.method==='POST'?202:200,headers:{'content-type':'application/json',etag:'revision'}});
  });
  let error:unknown;
  try {await acts['apply-category-to-vm'](ctx);} catch(e){error=e;} finally{fetch.mockRestore();}
  return {posts,error};
}

test('association succeeds on older clusters without calling share',async()=>{
  const {posts,error}=await scenario('SUCCEEDED');expect(error).toBeUndefined();expect(posts).toHaveLength(1);
});
test('confirmed project rejection shares only with the VM project then retries',async()=>{
  const {posts,error}=await scenario('scope');expect(error).toBeUndefined();expect(posts).toHaveLength(3);
  expect(posts[1].url).toEndWith('/api/prism/v4.4/config/categories/cat/$actions/share');
  expect(posts[1].body).toEqual({projectExtId:'project'});
  expect(posts[2].body).toEqual({categories:[{extId:'cat'}]});
});
test('unrelated failures are surfaced without changing category sharing',async()=>{
  const {posts,error}=await scenario('denied');expect(String(error)).toContain('DENIED');expect(posts).toHaveLength(1);
});
test('unknown task outcomes are not retried or shared',async()=>{
  const {posts,error}=await scenario('unknown');expect(String(error)).toContain('unavailable');expect(posts).toHaveLength(1);
});
test('an existing category binding is a no-op',async()=>{
  const {posts,error}=await scenario('SUCCEEDED',true);expect(error).toBeUndefined();expect(posts).toHaveLength(0);
});
