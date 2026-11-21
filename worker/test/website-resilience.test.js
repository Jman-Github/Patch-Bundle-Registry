import test from "node:test";
import assert from "node:assert/strict";
import {ApiCatalog} from "../../shared/api-catalog.js";
import {D1Catalog} from "../src/d1-catalog.js";
import worker from "../src/index.js";
import {d1Fixture} from "./d1-fixture.js";

test("Website retries temporary manifest and snapshot failures without losing integrity checks", async()=>{
  const f=d1Fixture(), original=globalThis.fetch, calls=new Map();
  globalThis.fetch=async (url,options)=>{
    const path=new URL(url).pathname, count=(calls.get(path)??0)+1;
    calls.set(path,count);
    if(count===1) return Response.json({error:"Temporary outage"},{status:503});
    return worker.fetch(new Request(url,options),f.env);
  };
  try {
    const api=await new ApiCatalog("https://api.test").initialize();
    assert.ok((await api.apps()).length>0);
    assert.ok(calls.size>=2);
    assert.ok([...calls.values()].every(count=>count===2));
    assert.equal(api.manifest.generation,f.old.manifest.generation);
  } finally {globalThis.fetch=original;f.sqlite.close();}
});

test("Website startup can recover after the first three manifest requests fail", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = d1Fixture();
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    if (requests.length <= 3) return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
    return worker.fetch(new Request(url,options), fixture.env);
  };
  try {
    const loading = new ApiCatalog("https://api.test").initialize();
    for (const delay of [1250, 3250, 7250]) {
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(delay);
    }
    const catalog = await loading;
    assert.equal(catalog.manifest.generation, fixture.old.manifest.generation);
    assert.deepEqual(requests, Array(4).fill("https://api.test/catalog/data/manifest.json"));
  } finally {
    globalThis.fetch = original;
    fixture.sqlite.close();
  }
});

test("Website retries the same bundle and patch page once after a temporary failure", async()=>{
  const original=globalThis.fetch, calls=[];
  let bundleCalls=0, patchCalls=0;
  globalThis.fetch=async input=>{
    const url=new URL(input);calls.push(url.href);
    if(url.pathname==="/catalog/bundles") {
      if(++bundleCalls===1) throw new TypeError("Network unavailable");
      return Response.json({data:[{id:"bundle"}]});
    }
    if(++patchCalls===1) return Response.json({error:"Upstream unavailable"},{status:502});
    return Response.json({rows:[{id:1}],next_cursor:null,candidate_pages:1});
  };
  try {
    const api=new ApiCatalog("https://api.test");api.manifest={generation:"a".repeat(24)};
    assert.equal((await api.bundles()).length,1);
    assert.equal((await api.patchRows({bundle_id:"bundle",all:true})).rows.length,1);
    assert.equal(calls[0],calls[1]);assert.equal(calls[2],calls[3]);
  } finally {globalThis.fetch=original;}
});

test("Website temporary retries stop, and permanent errors are not retried", async()=>{
  const original=globalThis.fetch;
  try {
    for(const status of [503,404,409,422,429]) {
      let calls=0;
      globalThis.fetch=async()=>{
        calls++;
        return Response.json({error:"Backend unavailable"},{status,
          headers:status===429?{"Retry-After":"60"}:{}});
      };
      const api=new ApiCatalog("https://api.test");api.manifest={generation:"a".repeat(24)};
      await assert.rejects(api.patchRows({bundle_id:"bundle"}),error=>error.status===status);
      assert.equal(calls,status===503?3:1);
    }
  } finally {globalThis.fetch=original;}
});

test("A page with 100 different sources uses bounded batched lookups",async()=>{
  const f=d1Fixture();
  try {
    const source=JSON.parse(f.sqlite.prepare("SELECT data FROM catalog_records WHERE kind='source' LIMIT 1").get().data);
    const bundle=JSON.parse(f.sqlite.prepare("SELECT data FROM catalog_records WHERE kind='bundle' LIMIT 1").get().data);
    f.sqlite.exec("DELETE FROM catalog_records WHERE kind IN ('source','bundle')");
    for(let i=1;i<=100;i++) {
      const id=i.toString(16).padStart(24,"0");
      f.add("source",id,{...source,id:i,catalog_id:id,url:"https://github.com/owner/repo"+i});
      f.add("bundle",id,{...bundle,id:i,catalog_id:id,source_fk:i,is_latest:true});
    }
    const page=await f.request("/catalog/bundles?limit=100&generation="+f.old.manifest.generation);
    assert.equal(page.data.length,100);
    assert.equal(new Set(page.data.map(row=>row.source.url)).size,100);
    assert.ok(f.queryLog.length<=5,"Expected at most five queries, got "+f.queryLog.length);
  } finally {f.sqlite.close();}
});

test("Current large catalog documents are retained by the bounded cache",async()=>{
  const f=d1Fixture();
  try {
    const document=JSON.parse(f.objects.get("generations/test.json"));
    document.padding="x".repeat(9*1024*1024);
    f.objects.set("generations/test.json",JSON.stringify(document));
    await new D1Catalog(f.env,{cacheDocuments:true}).initialize();
    await new D1Catalog(f.env,{cacheDocuments:true}).initialize();
    assert.equal(f.reads.length,1);
    assert.equal(f.queryLog.length,2);
  } finally {f.sqlite.close();}
});

test("Website automatically recovers a transient bundle detail failure",async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{
    if(++calls===1) return Response.json({error:"Temporary"},{status:503});
    return Response.json({description:"Recovered"},{headers:{"X-Catalog-Generation":"a".repeat(24)}});
  };
  try {
    const api=new ApiCatalog("https://api.test");api.manifest={generation:"a".repeat(24)};
    assert.equal((await api.file("bundles/"+"b".repeat(24)+".json")).description,"Recovered");
    assert.equal(calls,2);
  } finally {globalThis.fetch=original;}
});

test("Oversized catalog documents are not retained indefinitely",async()=>{
  const f=d1Fixture();
  try {
    const document=JSON.parse(f.objects.get("generations/test.json"));
    document.padding="x".repeat(12*1024*1024);
    f.objects.set("generations/test.json",JSON.stringify(document));
    for(let i=0;i<2;i++) await new D1Catalog(f.env,{cacheDocuments:true}).initialize();
    assert.equal(f.reads.length,2);
  } finally {f.sqlite.close();}
});

test("Removed bundle details trigger recovery only when the API generation changed",async()=>{
  const original=globalThis.fetch;
  try {
    for(const generation of ["a".repeat(24),"c".repeat(24)]) {
      let calls=0;
      globalThis.fetch=async()=>{
        calls++;
        return Response.json({error:"Record not found"},{status:404,
          headers:{"X-Catalog-Generation":generation}});
      };
      const api=new ApiCatalog("https://api.test");api.manifest={generation:"a".repeat(24)};
      await assert.rejects(api.file("bundles/"+"b".repeat(24)+".json"),
        error=>error.status===404 && error.generationUnavailable===(generation!==api.manifest.generation));
      assert.equal(calls,1);
    }
  } finally {globalThis.fetch=original;}
});
