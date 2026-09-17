import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEnergyRead, energyReadNote} from '../src/powerMonitors.ts';

const row = {id:'inventory:0', index:0, name:'CPU', typeRaw:1, type:'rail', availability:'available', reason:null,
  rawEnergyUws:'1500000', rawSnapshotUptimeMs:'100', joules:1.5, snapshotAgeAtReadMs:200, callbackUptimeMs:300};
const sample = {source:'SystemHealthManager.powerMonitors', status:'ready', reason:null, queryStage:'readings',
  inventoryId:'inventory', pid:10, uid:10001, sequence:1, apiLevel:35, fingerprint:'fixture', scope:'device_subsystems',
  finePermissionGranted:false, collectionMode:'manual', queryStartedUptimeMs:290, queryFinishedUptimeMs:301,
  queryDurationMs:11, recordedAtMs:100000, monitorCount:1, monitors:[row]};

test('energy preserves zero and raw integers beyond JS exact precision', () => {
  for (const rawEnergyUws of ['0','1500000','9223372036854775807']) {
    const m={...row,rawEnergyUws,joules:Number(rawEnergyUws)/1e6};
    assert.equal(validateEnergyRead({...sample,monitors:[m]}).monitors[0].rawEnergyUws,rawEnergyUws);
  }
  for(const rawEnergyUws of ['9223372036854775808','1.0','01','1e6','-0'])
    assert.throws(()=>validateEnergyRead({...sample,monitors:[{...row,rawEnergyUws}]}));
});
test('missing energy cannot masquerade as zero; empty and old OS are distinct', () => {
  const missing={...row,availability:'unavailable',reason:'energy_unavailable',rawEnergyUws:'-1',joules:null,snapshotAgeAtReadMs:null};
  assert.equal(validateEnergyRead({...sample,monitors:[missing]}).monitors[0].joules,null);
  assert.throws(()=>validateEnergyRead({...sample,monitors:[{...missing,joules:0}]}));
  assert.throws(()=>validateEnergyRead({...sample,monitors:[{...missing,rawEnergyUws:'0'}]}));
  for(const [status,reason,apiLevel] of [['empty','no_exposed_monitors',35],['unsupported','requires_api_35',34],['error','callback_timeout',35]]) {
    const result=validateEnergyRead({...sample,status,reason,apiLevel,monitors:[],monitorCount:0});
    assert.ok(energyReadNote(result).length>10);
  }
});
test('repeated snapshot timestamps retain age and do not imply fresh energy', () => {
  const later={...sample,sequence:2,queryStartedUptimeMs:5300,queryFinishedUptimeMs:5311,
    monitors:[{...row,callbackUptimeMs:5310,snapshotAgeAtReadMs:5210}]};
  assert.equal(validateEnergyRead(later).monitors[0].rawSnapshotUptimeMs,'100');
  for(const extra of [{snapshotAgeAtReadMs:0},{rawSnapshotUptimeMs:'5400'},{joules:2}])
    assert.throws(()=>validateEnergyRead({...later,monitors:[{...later.monitors[0],...extra}]}));
});
test('vendor names may repeat; identities and type declarations must remain coherent', () => {
  const consumer={...row,id:'inventory:1',index:1,typeRaw:0,type:'consumer'};
  assert.equal(validateEnergyRead({...sample,monitorCount:2,monitors:[row,consumer]}).monitors.length,2);
  for(const bad of [{...consumer,id:row.id},{...consumer,type:'rail'},{...consumer,index:0}])
    assert.throws(()=>validateEnergyRead({...sample,monitorCount:2,monitors:[row,bad]}));
  assert.throws(()=>validateEnergyRead({...sample,monitorCount:0}));
});
