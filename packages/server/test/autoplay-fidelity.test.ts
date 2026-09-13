import { expect, test, spyOn } from 'bun:test';
import { VariableStore, type ActContext, type CheckContext } from '@ntnx-game/engine';
import { acts } from '../../../packs/ntnx-infiltration/acts';
import { checks } from '../../../packs/ntnx-infiltration/checks';
import { ensureRecoveryPoint, restoreRecoveryVm } from '../../../packs/ntnx-infiltration/acts/recovery';
import { dailyScheduleError } from '../../../packs/ntnx-infiltration/schedule';

function context() {
  const vars = new VariableStore();
  for (const [k,v] of Object.entries({Trigram:'fid',PC:'https://pc.invalid',PCUser:'admin',PCPassword:'test'})) vars.set(k,v,'test');
  const cache = new Map<string, any>();
  return {vars,session:{id:'s',trigram:'fid',locale:'en',clusterProfile:'hpoc'},
    cache:{get:(k:string,n:string)=>cache.get(k+n),set:(e:any)=>cache.set(e.kind+e.logicalName,e),all:()=>[...cache.values()]},
    logger:{debug(){},info(){},warn(){},error(){}},nutanix:{mode:'live',sdk:{},rest:{request:async()=>({})}},
  } as unknown as ActContext;
}
const app = {metadata:{uuid:'app',kind:'app'},spec:{resources:{action_list:[{name:'Refresh VM',uuid:'refresh'}]}}};
const goodJob = {type:'RECURRING',state:'ACTIVE',schedule_info:{schedule:'0 3 * * *'},executable:{entity:{uuid:'app',type:'app'},action:{type:'APP_ACTION_RUN',spec:{uuid:'refresh'}}}};

test('daily schedule rejects empty or wrong actions, weekly/disabled/multiple runs',()=>{
  expect(dailyScheduleError(goodJob,'app','refresh')).toBeUndefined();
  for(const resources of [ {...goodJob,executable:{entity:{uuid:'app'}}}, {...goodJob,state:'INACTIVE'},
    {...goodJob,schedule_info:{schedule:'0 3 * * 1'}}, {...goodJob,schedule_info:{schedule:'* * * * *'}} ]) {
    expect(dailyScheduleError(resources,'app','refresh')).toBeDefined();
  }
  expect(dailyScheduleError(goodJob,'app','wrong')).toContain('Refresh VM');
});

test('schedule act repairs the existing empty-action job with an executable payload',async()=>{
  const ctx=context(); const writes:any[]=[];
  ctx.nutanix.rest.request=async(method:string,path:string,body?:any):Promise<any>=>{
    if(method==='PUT'){writes.push(body);return {};}
    if(path.endsWith('apps/list'))return {entities:[{metadata:{uuid:'app'},status:{name:'fid-app'}}]};
    if(path.endsWith('apps/app'))return app;
    if(path.endsWith('jobs/list'))return {entities:[{metadata:{uuid:'job',name:'fid-sched'},resources:{executable:{action:{}}}}]};
    if(path.endsWith('jobs/job'))return {metadata:{uuid:'job',name:'fid-sched',spec_version:3}};
    throw new Error(path);
  };
  await acts['schedule-day2-action'](ctx);
  expect(writes).toHaveLength(1);
  expect(writes[0].metadata.spec_version).toBe(3);
  expect(writes[0].resources.executable.action.spec.uuid).toBe('refresh');
  expect(JSON.parse(writes[0].resources.executable.action.spec.payload).spec).toEqual({args:[],target_kind:'Application',target_uuid:'app'});
});

test('storage check rejects unspecified encryption and a missing Critical category',async()=>{
  const ctx=context(); const policy:any={name:'fid-sto-policy',extId:'policy',encryptionSpec:{encryptionState:'SYSTEM_DERIVED'},categoryExtIds:['critical']};
  ctx.nutanix.sdk={datapolicies:{storage:{listStoragePolicies:async()=>({data:{data:[policy]}})}},prism:{categories:{listCategories:async()=>({data:{data:[{key:'fid-cat',value:'Critical',extId:'critical'}]}})}}};
  ctx.nutanix.rest.request=async():Promise<any>=>({data:[{key:'fid-cat',value:'Critical',extId:'critical'}]});
  const check=()=>checks.CheckStoragePolicy(ctx as unknown as CheckContext);
  expect((await check()).pass).toBe(false);
  policy.encryptionSpec.encryptionState='ENABLED';policy.categoryExtIds=[];
  expect((await check()).pass).toBe(false);
  policy.categoryExtIds=['critical'];expect((await check()).pass).toBe(true);
});

test('restore uses a completed recovery point, never the VM create endpoint',async()=>{
  const ctx=context();let restored=false;const writes:any[]=[];
  ctx.nutanix.sdk={vmm:{vms:{listVms:async()=>({data:{data:restored?[{name:'fid-vm',extId:'restored',powerState:'ON'}]:[]}})}}};
  ctx.nutanix.rest.request=async(_m:string,path:string):Promise<any>=>{
    if(path.includes('/tasks/')){restored=true;return {data:{status:'SUCCEEDED'}};}
    return {data:[{name:'fid-game-recovery',extId:'point',status:'COMPLETE',vmRecoveryPoints:[{extId:'vm-point',vmExtId:'original'}]}]};
  };
  const fetch=spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    writes.push({url:String(url),body:JSON.parse(String(init?.body))});return Response.json({data:{extId:'restore-task'}});
  });
  try {await restoreRecoveryVm(ctx);await restoreRecoveryVm(ctx);}finally{fetch.mockRestore();}
  expect(writes).toHaveLength(1);expect(writes[0].url).toEndWith('/point/$actions/restore');
  expect(writes[0].body.vmRecoveryPointRestoreOverrides[0].vmRecoveryPointExtId).toBe('vm-point');
});

test('missing or failed recovery points never fall back to VM creation',async()=>{
  const ctx=context();ctx.nutanix.sdk={vmm:{vms:{listVms:async()=>({data:{data:[]}})}}};
  ctx.nutanix.rest.request=async():Promise<any>=>({data:[{name:'fid-game-recovery',extId:'point',status:'FAILED'}]});
  await expect(restoreRecoveryVm(ctx)).rejects.toThrow('No completed');
});

test('failed snapshot task is surfaced before deletion can proceed',async()=>{
  const ctx=context();ctx.nutanix.rest.request=async(_m:string,path:string):Promise<any>=>path.includes('/tasks/')?{data:{status:'FAILED',errorMessages:['snapshot rejected']}}:{data:[]};
  const fetch=spyOn(globalThis,'fetch').mockResolvedValue(Response.json({data:{extId:'task'}}));
  try{await expect(ensureRecoveryPoint(ctx,'original')).rejects.toThrow('snapshot rejected');}finally{fetch.mockRestore();}
});

test('storage act adds Critical while preserving existing category bindings',async()=>{
  const ctx=context();const writes:any[]=[];
  ctx.nutanix.sdk={
    datapolicies:{storage:{listStoragePolicies:async()=>({data:{data:[{name:'fid-sto-policy',extId:'policy',categoryExtIds:['other'],encryptionSpec:{encryptionState:'ENABLED'}}]}})}},
    prism:{categories:{listCategories:async()=>({data:{data:[{key:'fid-cat',value:'Critical',extId:'critical'}]}})}},
  };
  const fetch=spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    if(init?.method==='PUT') writes.push(JSON.parse(String(init.body)));
    return Response.json({data:{extId:'policy'}},{headers:{etag:'revision'}});
  });
  try{await acts['create-storage-policy'](ctx);}finally{fetch.mockRestore();}
  expect(writes).toHaveLength(1);expect(writes[0].categoryExtIds).toEqual(['other','critical']);
  expect(writes[0].encryptionSpec.encryptionState).toBe('ENABLED');
});

test('reports use the next 03:00 and validate the selected timezone',async()=>{
  const {nextReportTime, reportRunsAtThree}=await import('../../../packs/ntnx-infiltration/schedule');
  expect(nextReportTime(new Date('2026-09-13T02:59:00Z'))).toBe('2026-09-13T03:00:00.000Z');
  expect(nextReportTime(new Date('2026-09-13T03:00:00Z'))).toBe('2026-09-14T03:00:00.000Z');
  expect(reportRunsAtThree('2026-09-13T01:00:00Z','Europe/Zurich')).toBe(true);
  expect(reportRunsAtThree('2026-09-13T03:00:00Z','Europe/Zurich')).toBe(false);
  expect(reportRunsAtThree(undefined)).toBe(false);
  expect(reportRunsAtThree('invalid')).toBe(false);
});

test('report act repairs an old schedule without replacing its recipients or widgets',async()=>{
  const ctx=context();const writes:any[]=[];
  const old={name:'fid-report',extId:'report',sections:[{name:'VMs',rows:[]}],notificationPolicy:{recipients:[{emailAddress:'fid@example.com'}]},schedule:{scheduleInterval:'DAILY',frequency:1,startTime:'2026-01-01T12:00:00Z'}};
  ctx.nutanix.sdk={opsmgmt:{reportConfigs:{listReportConfigs:async()=>({data:{data:[old]}})}}};
  const fetch=spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
    if(init?.method==='PUT')writes.push(JSON.parse(String(init.body)));
    return Response.json({data:old},{headers:{etag:'revision'}});
  });
  try{await acts['create-report'](ctx);}finally{fetch.mockRestore();}
  expect(writes).toHaveLength(1);
  expect(writes[0].notificationPolicy).toEqual(old.notificationPolicy);expect(writes[0].sections).toEqual(old.sections);
  expect(writes[0].schedule.startTime).toContain('T03:00:00.000Z');expect(writes[0].extId).toBeUndefined();
});
