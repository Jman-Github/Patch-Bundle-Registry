import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import {d1Fixture} from "./d1-fixture.js";

test("Conditional GET accepts weak tags, tag lists and wildcard on JSON and catalog files",async()=>{
  const f=d1Fixture();
  try {
    for(const path of ["/health","/catalog/data/manifest.json",
      "/catalog/data/snapshots/"+f.old.manifest.generation+"/sources.json"]) {
      const first=await worker.fetch(new Request("https://api.test"+path),f.env);
      assert.equal(first.status,200);
      const etag=first.headers.get("ETag");assert.ok(etag);
      for(const condition of [etag,"W/"+etag,'"other", W/'+etag,"*"]) {
        const response=await worker.fetch(new Request("https://api.test"+path,{
          headers:{"If-None-Match":condition}}),f.env);
        assert.equal(response.status,304,path+" "+condition);
        assert.equal(await response.text(),"");
        assert.equal(response.headers.get("ETag"),etag);
      }
      const changed=await worker.fetch(new Request("https://api.test"+path,{
        headers:{"If-None-Match":'W/"different"'}}),f.env);
      assert.equal(changed.status,200);
    }
    const post=await worker.fetch(new Request("https://api.test/graphql",{method:"POST",
      headers:{"Content-Type":"application/json","If-None-Match":"*"},
      body:JSON.stringify({query:"{bundle(limit:1){id}}"})}),f.env);
    assert.equal(post.status,200);
  } finally {f.sqlite.close();}
});

test("Unreadable R2 catalog JSON produces a retryable response",async()=>{
  const f=d1Fixture();
  try {
    const key="generations/test.json";
    const original=f.objects.get(key);
    const request=()=>worker.fetch(new Request("https://api.test/catalog/data/manifest.json"),f.env);
    f.objects.set(key,"{");
    const failure=await request();
    assert.equal(failure.status,503);
    assert.equal(failure.headers.get("Cache-Control"),"no-store");
    assert.equal((await failure.json()).error,"Catalog snapshot unreadable");

    f.objects.set(key,original);
    const retry=await request();
    assert.equal(retry.status,200);
    assert.deepEqual(await retry.json(),f.old.manifest);
  } finally {f.sqlite.close();}
});

test("Historical snapshot reads use only the requested ready generation",async()=>{
  const f=d1Fixture();
  try {
    const historical="e".repeat(24),key="generations/historical.json";
    const currentKey="generations/test.json";
    const document=JSON.parse(f.objects.get(currentKey));
    f.objects.delete(currentKey);
    const request=()=>worker.fetch(new Request(
      "https://api.test/catalog/data/snapshots/"+historical+"/sources.json"),f.env);
    assert.equal((await request()).status,404);

    f.sqlite.prepare("INSERT INTO catalog_generations VALUES(2,?,?,'ready','now')").run(historical,key);
    const missing=await request();
    assert.equal(missing.status,503);
    assert.equal((await missing.json()).error,"Catalog snapshot unavailable");

    f.objects.set(key,JSON.stringify(document));
    const mismatch=await request();
    assert.equal(mismatch.status,503);
    assert.equal(mismatch.headers.get("Cache-Control"),"no-store");
    assert.equal((await mismatch.json()).error,"Catalog generation mismatch");
    assert.deepEqual(f.reads,[key,key]);

    document.manifest.generation=historical;
    document.manifest.snapshot="snapshots/"+historical;
    f.objects.set(key,JSON.stringify(document));
    const repaired=await request();
    assert.equal(repaired.status,200);
    assert.equal(repaired.headers.get("X-Catalog-Generation"),historical);
    assert.match(repaired.headers.get("Cache-Control"),/immutable/);
    assert.deepEqual(await repaired.json(),JSON.parse(f.old.bodies["sources.json"]));
    assert.deepEqual(f.reads,[key,key,key,"objects/"+document.files["sources.json"]]);
    assert.equal(f.queryLog.length,4);
  } finally {f.sqlite.close();}
});

test("Snapshot file responses reject a mismatched R2 object mapping",async()=>{
  const f=d1Fixture();
  try {
    const key="generations/test.json";
    const original=f.objects.get(key);
    const document=JSON.parse(original);
    const path="/catalog/data/snapshots/"+document.manifest.generation+"/sources.json";
    const context={waitUntil(){}};
    const request=()=>worker.fetch(new Request("https://api.test"+path),f.env,context);

    document.files["sources.json"]=document.files["bundles.json"];
    f.objects.set(key,JSON.stringify(document));
    const mismatch=await request();
    assert.equal(mismatch.status,503);
    assert.equal(mismatch.headers.get("Cache-Control"),"no-store");
    assert.equal((await mismatch.json()).error,"Catalog file index mismatch");
    assert.deepEqual(f.reads,[key]);

    f.objects.set(key,original);
    const repaired=await request();
    assert.equal(repaired.status,200);
    assert.equal(repaired.headers.get("ETag"),'"'+document.manifest.files["sources.json"].sha256+'"');
    assert.deepEqual(await repaired.json(),JSON.parse(f.old.bodies["sources.json"]));
  } finally {f.sqlite.close();}
});

test("Conditional snapshot requests check R2 metadata without fetching a body", async () => {
  const f=d1Fixture();
  try {
    const calls=[];
    f.env.ARCHIVE.head=async key => {
      calls.push(key);
      return f.objects.has(key) ? {key} : null;
    };
    const name="sources.json", generation=f.old.manifest.generation;
    const digest=f.old.manifest.files[name].sha256;
    const request=()=>worker.fetch(new Request("https://api.test/catalog/data/snapshots/"+generation+"/"+name,{
      headers:{"If-None-Match":'W/"'+digest+'"'}
    }),f.env);
    const response=await request();
    assert.equal(response.status,304);
    assert.deepEqual(f.reads,["generations/test.json"]);
    assert.deepEqual(calls,["objects/"+digest]);
    f.objects.delete("objects/"+digest);
    assert.equal((await request()).status,503);
  } finally { f.sqlite.close(); }
});

test("Cached GET responses accept weak validators after proxy compression",async()=>{
  const f=d1Fixture(),original=globalThis.caches,stored=new Map(),pending=[];
  globalThis.caches={default:{async match(key){return stored.get(key.url)?.clone();},
    async put(key,response){stored.set(key.url,response.clone());}}};
  try {
    const context={waitUntil:promise=>pending.push(promise)};
    const initial=await worker.fetch(new Request("https://api.test/health"),f.env,context);
    await Promise.all(pending);
    assert.equal(stored.size,1);
    const response=await worker.fetch(new Request("https://api.test/health",{
      headers:{"If-None-Match":"W/"+initial.headers.get("ETag")}}),f.env,context);
    assert.equal(response.status,304);
  } finally {globalThis.caches=original;f.sqlite.close();}
});

test("D1 cache hits skip R2 for API responses and the public manifest",async()=>{
  const f=d1Fixture(),original=globalThis.caches,stored=new Map(),pending=[];
  globalThis.caches={default:{async match(key){return stored.get(key.url)?.clone();},
    async put(key,response){stored.set(key.url,response.clone());}}};
  try {
    const context={waitUntil:promise=>pending.push(promise)};
    const key="generations/test.json";
    const document=JSON.parse(f.objects.get(key));
    // Keep the object above the isolate cache limit so R2 reads measure edge hits.
    document.padding="x".repeat(12*1024*1024);
    f.objects.set(key,JSON.stringify(document));
    const origin=f.env.CORS_ORIGINS.split(",")[0].trim();
    const current=document.manifest.generation;
    const next="e".repeat(24);
    const paths=["/health","/catalog/data/manifest.json"];
    const request=(path,headers={Origin:origin})=>worker.fetch(
      new Request("https://api.test"+path,{headers}),f.env,context);
    const coldBodies=new Map();
    for(const path of paths) {
      const cold=await request(path);
      assert.equal(cold.status,200);
      const body=await cold.text();
      coldBodies.set(path,body);
      await Promise.all(pending);

      const warm=await request(path);
      assert.equal(warm.status,200);
      assert.equal(warm.headers.get("Access-Control-Allow-Origin"),origin);
      assert.equal(warm.headers.get("Cache-Control"),"public, max-age=60");
      assert.equal(await warm.text(),body);
      const conditional=await request(path,{Origin:origin,"If-None-Match":"W/"+cold.headers.get("ETag")});
      assert.equal(conditional.status,304);
      assert.equal(await conditional.text(),"");
    }
    assert.equal(
      [...stored.values()].find(response => response.headers.get("ETag") === '"manifest-'+current+'"')
        .headers.get("Cache-Control"),
      "public, max-age=900"
    );
    assert.deepEqual(f.reads,[key,key]);
    assert.equal(f.queryLog.filter(sql=>sql.includes("catalog_state")).length,6);

    const other=await request(paths[1],{Origin:"https://other.test"});
    assert.equal(other.headers.get("Access-Control-Allow-Origin"),null);
    assert.equal(await other.text(),coldBodies.get(paths[1]));
    await Promise.all(pending);
    const sameManifest=await request(paths[1]+"?ignored=1",{Origin:"https://different.test"});
    assert.equal(sameManifest.headers.get("Access-Control-Allow-Origin"),null);
    assert.equal(await sameManifest.text(),coldBodies.get(paths[1]));
    assert.deepEqual(f.reads,[key,key,key]);

    document.manifest.generation=next;
    f.objects.set("generations/next.json",JSON.stringify(document));
    f.sqlite.prepare("INSERT INTO catalog_generations VALUES(2,?,'generations/next.json','ready','now')").run(next);
    f.sqlite.exec("UPDATE catalog_state SET active_seq=2");
    for(const path of paths) {
      const rotated=await request(path,{"If-None-Match":'"manifest-'+current+'"',Origin:origin});
      assert.equal(rotated.status,200);
      assert.equal(rotated.headers.get("X-Catalog-Generation"),next);
      assert.equal((await rotated.json()).generation,next);
    }
    assert.deepEqual(f.reads,[key,key,key,"generations/next.json","generations/next.json"]);
    await Promise.all(pending);
  } finally {globalThis.caches=original;f.sqlite.close();}
});
