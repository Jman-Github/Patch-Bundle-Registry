import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import worker from "../src/index.js";
import {D1Catalog} from "../src/d1-catalog.js";
import {CatalogSubscriptions} from "../src/subscriptions.js";
import {handleAdmission} from "../src/subscription-admission.js";
import {d1Fixture} from "./d1-fixture.js";

test("D1 aliases, filters, sorts, patches and legacy imports avoid oversized R2 catalog indexes",async()=>{
  const f=d1Fixture();
  try {
    const document=JSON.parse(f.objects.get("generations/test.json"));
    for (const name of ["bundles.json","patch-index.json"]) document.manifest.files[name].bytes=24*1024*1024;
    f.objects.set("generations/test.json",JSON.stringify(document));
    for (const path of ["/bundles?limit=1","/api/v1/bundles?limit=1","/api/v1/releases?limit=1",
      "/bundles?q=video&limit=1","/bundles?package=com.video","/bundles?channel=stable",
      "/bundles?sort=version&order=desc","/api/v1/sources?q=owner",
      "/api/v1/bundle/1","/api/v1/bundle/owner/repo/latest","/api/v2/bundle/owner/repo/latest?channel=stable",
      "/patches?limit=1","/api/v1/patches?q=ads","/bundles/"+f.old.bundle.id+"/patches?package=com.video"])
      await f.request(path);
    const forbidden=["bundles.json","patch-index.json"].map(name=>"objects/"+document.files[name]);
    assert.ok(f.reads.every(key=>!forbidden.includes(key)),JSON.stringify(f.reads));
    assert.equal((await f.request("/bundles?q=not-present")).total,0);
    assert.equal((await f.request("/patches?q=not-present")).total,0);
  } finally {f.sqlite.close();}
});

test("D1 filtered pagination remains complete across more than one database scan page",async()=>{
  const f=d1Fixture();
  try {
    const template=JSON.parse(f.sqlite.prepare("SELECT data FROM catalog_records WHERE kind='bundle' LIMIT 1").get().data);
    f.sqlite.exec("DELETE FROM catalog_records WHERE kind='bundle'");
    for (let i=0;i<237;i++) {
      const id=i.toString(16).padStart(24,"0");
      f.add("bundle",id,{...template,id:i+1,catalog_id:id,version:"v"+i,description:"Find me "+i});
    }
    const ids=[];
    for (let offset=0;offset<237;offset+=37) {
      const page=await f.request("/bundles?q=find%20me&limit=37&offset="+offset);
      assert.equal(page.total,237);ids.push(...page.data.map(row=>row.id));
    }
    assert.equal(new Set(ids).size,237);
  } finally {f.sqlite.close();}
});

test("D1 browsing preserves JavaScript Unicode search and source URL normalization",async()=>{
  const f=d1Fixture();
  try {
    f.sqlite.prepare("UPDATE catalog_records SET data=json_set(data,'$.url',?) WHERE kind='source'")
      .run("https://github.com/Owner/Repo");
    f.sqlite.prepare("UPDATE catalog_records SET data=json_set(data,'$.description',?) WHERE kind='bundle'")
      .run("Unicode \u212aelvin and \u00c9clair");
    assert.equal((await f.request("/bundles?q=kelvin")).total,2);
    assert.equal((await f.request("/bundles?q="+encodeURIComponent("\u00e9clair"))).total,2);
    const history=await f.request("/catalog/bundles?generation="+f.old.manifest.generation+
      "&source=https://github.com/owner/repo");
    assert.equal(history.data.length,2);
  } finally {f.sqlite.close();}
});

test("D1 REST and GraphQL compute identical bundle images",async()=>{
  const f=d1Fixture();
  try {
    f.sqlite.prepare("UPDATE catalog_records SET data=json_set(data,'$.source_metadatum.owner_avatar_url',?,'$.source_metadatum.bundle_icon_url',?) WHERE kind='source'")
      .run("https://example.test/avatar.png","https://example.test/bundle.png");
    f.sqlite.exec("UPDATE catalog_records SET data=json_set(data,'$.bundle_type','Morphe:V1') WHERE kind='bundle'");
    const rest=await f.request("/bundles/"+f.old.bundle.id);
    const graph=await f.graph("{bundle(where:{id:{_eq:1}}){icon_url owner_avatar_url}}");
    assert.deepEqual(graph.data.bundle[0],{icon_url:rest.icon_url,owner_avatar_url:rest.owner_avatar_url});
  } finally {f.sqlite.close();}
});

test("Immutable document caching saves R2 reads while active generation is checked on every request",async()=>{
  const f=d1Fixture();
  try {
    for(let i=0;i<2;i++) await new D1Catalog(f.env,{cacheDocuments:true}).initialize();
    assert.equal(f.reads.length,1);
    assert.equal(f.queryLog.filter(sql=>sql.includes("catalog_state")).length,2);
    const next="e".repeat(24),document=JSON.parse(f.objects.get("generations/test.json"));
    document.manifest.generation=next;
    f.objects.set("generations/next.json",JSON.stringify(document));
    f.sqlite.prepare("INSERT INTO catalog_generations VALUES(2,?,'generations/next.json','ready','now')").run(next);
    f.sqlite.exec("UPDATE catalog_state SET active_seq=2");
    assert.equal((await new D1Catalog(f.env,{cacheDocuments:true}).initialize()).manifest.generation,next);
    assert.equal(f.reads.length,2);
  } finally {f.sqlite.close();}
});

test("Failed document reads are evicted and can retry",async()=>{
  const f=d1Fixture();let calls=0;
  const get=f.env.ARCHIVE.get;
  f.env.ARCHIVE.get=async key=>{if(++calls===1)throw Error("temporary");return get(key);};
  try {
    await assert.rejects(new D1Catalog(f.env,{cacheDocuments:true}).initialize(),/temporary/);
    await new D1Catalog(f.env,{cacheDocuments:true}).initialize();
    assert.equal(calls,2);
  } finally {f.sqlite.close();}
});

test("A repaired catalog file index is retried within the same generation",async()=>{
  const f=d1Fixture();
  try {
    const key="generations/test.json";
    const original=f.objects.get(key);
    for(const missing of ["manifest.files","files"]) {
      const broken=JSON.parse(original);
      if (missing==="manifest.files") delete broken.manifest.files;
      else delete broken.files;
      f.objects.set(key,JSON.stringify(broken));
      const archive={get:f.env.ARCHIVE.get};
      const env={...f.env,ARCHIVE:archive};
      const context={waitUntil(){}};
      const request=()=>worker.fetch(new Request("https://api.test/catalog/data/manifest.json"),env,context);
      const failure=await request();
      assert.equal(failure.status,503);
      assert.equal((await failure.json()).error,"Catalog file index unavailable");

      f.objects.set(key,original);
      const retry=await request();
      assert.equal(retry.status,200);
      assert.deepEqual(await retry.json(),f.old.manifest);
    }
    assert.deepEqual(f.reads,Array(4).fill(key));
  } finally {f.sqlite.close();}
});

test("Bundle details recover from a changed generation once and retain all filters",async()=>{
  const source=readFileSync(new URL("../../web/app.js",import.meta.url),"utf8");
  const code=source.slice(source.indexOf("async function bundlePatches("),source.indexOf("\nasync function bundleChangelog("));
  let calls=0,recoveries=0;
  const context={catalog:{patchRows:async args=>{
    assert.equal(args.package,"com.video");assert.equal(args.compact,true);
    if(++calls===1)throw Object.assign(Error("changed"),{generationUnavailable:true});
    return {rows:[{name:"Recovered"}]};
  }},recoverGeneration:async()=>{recoveries++;return true;},transformPatch:row=>row};
  runInNewContext(code,context);
  assert.equal((await context.bundlePatches({id:"bundle",appPackage:"com.video"}))[0].name,"Recovered");
  assert.equal(recoveries,1);assert.equal(calls,2);
  calls=0;context.catalog.patchRows=async()=>{calls++;throw Error("permanent");};
  await assert.rejects(context.bundlePatches({id:"missing"}),/permanent/);
  assert.equal(calls,2); // Recovery is attempted once; the second failure is returned.
});

function storage(values=new Map()) {
  const result={get:async key=>structuredClone(values.get(key)),
    put:async(key,value)=>values.set(key,structuredClone(value)),delete:async key=>values.delete(key),
    getAlarm:async()=>null,setAlarm:async()=>{}};
  result.transaction=async callback=>callback(result);
  return result;
}
test("Shared subscription admission enforces per-client and global limits and releases expired leases",async()=>{
  const ctx={storage:storage()},env={CATALOG_SUBSCRIPTION_MAX_CONNECTIONS:"2",CATALOG_SUBSCRIPTION_CONNECTIONS_PER_IP:"1"};
  const call=(action,id,client)=>handleAdmission(ctx,env,{action,id,client});
  assert.equal((await call("reserve","a","a".repeat(64))).status,200);
  assert.equal((await call("reserve","b","a".repeat(64))).status,429);
  assert.equal((await call("reserve","b","b".repeat(64))).status,200);
  assert.equal((await call("reserve","c","c".repeat(64))).status,429);
  await call("release","a");
  assert.equal((await call("reserve","c","c".repeat(64))).status,200);
  const leases=await ctx.storage.get("leases");
  await ctx.storage.put("leases",leases.map(row=>({...row,expires:0})));
  assert.equal((await call("reserve","d","d".repeat(64))).status,200);
  assert.equal((await call("renew","absent")).status,429);
});

test("Generation-aware polling skips settled data, but drains streams and polls live jobs",async()=>{
  const values=new Map(),st=storage(values);
  let generation="g1",fetches=0;
  const state={id:"client",protocol:"graphql-transport-ws",initialized:true};
  const ws={deserializeAttachment:()=>state,send:()=>{}};
  const operations={
    settled:{token:"a",payload:{query:"subscription {source{id}}"},generation,settled:true},
    stream:{token:"b",payload:{query:"subscription {source_stream{id}}"},generation,settled:false},
    jobs:{token:"c",payload:{query:"subscription {refresh_jobs{id}}"},generation,settled:true}
  };
  values.set("connection:client",operations);
  const env={CATALOG_BACKEND:"d1",DB:{prepare:()=>({first:async()=>({generation})})},
    SUBSCRIPTIONS:{idFromName:x=>x,get:()=>({fetch:async()=>{
      fetches++;return Response.json({data:{},extensions:{registryGeneration:generation}});
    }})}};
  const object=new CatalogSubscriptions({storage:st,getWebSockets:()=>[ws]},env);
  await object.alarm();assert.equal(fetches,2);
  generation="g2";await object.alarm();assert.equal(fetches,5);
});

test("Detail recovery coalesces with an in-flight generation refresh without blocking search recovery",async()=>{
  const source=readFileSync(new URL("../../web/app.js",import.meta.url),"utf8");
  const code=source.slice(source.indexOf("async function recoverGeneration("),source.indexOf("\nasync function selectSource("));
  let release,opened=0;
  const context={refreshingCatalog:true,activeCatalogRefresh:new Promise(resolve=>{release=resolve;}),
    catalog:{manifest:{generation:"old"}},openCatalog:async()=>{opened++;return {manifest:{generation:"new"}};},
    loadBundles:async()=>true};
  runInNewContext(code,context);
  const error={generationUnavailable:true};
  const waiting=context.recoverGeneration(error,true);
  assert.equal(await context.recoverGeneration(error),false);
  release(true);assert.equal(await waiting,true);assert.equal(opened,0);
  context.refreshingCatalog=false;
  const first=context.recoverGeneration(error,true),second=context.recoverGeneration(error,true);
  assert.equal(await first,true);assert.equal(await second,true);assert.equal(opened,1);
});


test("D1 browse combines search, channel and sort with SQL source and metadata filters",async()=>{
  const f=d1Fixture();
  try {
    for(const path of [
      "/bundles?q=video&source=demo",
      "/bundles?sort=version&metadata_status=verified",
      "/bundles?channel=stable&ecosystem=revanced",
      "/bundles?package=com.video&bundle_type=ReVanced:v22",
      "/sources?q=owner&source=demo"
    ]) {
      const expected=await worker.fetch(new Request("https://api.test"+path),f.old.env);
      const actual=await worker.fetch(new Request("https://api.test"+path),f.env);
      assert.equal(actual.status,expected.status,path);
      const a=await actual.json(),e=await expected.json();
      assert.ok(e.total>0,path);
      assert.equal(a.total,e.total,path);
      assert.deepEqual(a.data.map(row=>row.id),e.data.map(row=>row.id),path);
    }
  } finally {f.sqlite.close();}
});


test("D1 channel selectors reject inherited object properties as invalid input",async()=>{
  const f=d1Fixture();
  try {
    for(const path of ["/bundles","/apps","/patches"]) {
      for(const channel of ["constructor","__proto__","not-a-channel"]) {
        const response=await worker.fetch(new Request("https://api.test"+path+"?channel="+channel),f.env);
        assert.equal(response.status,400,path+" "+channel);
        assert.match((await response.json()).error,/channel/i);
      }
    }
  } finally {f.sqlite.close();}
});
