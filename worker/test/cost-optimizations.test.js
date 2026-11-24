import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import {d1Fixture} from "./d1-fixture.js";

function edgeCache() {
  const stored = new Map(), pending = [], original = globalThis.caches;
  globalThis.caches = {default:{async match(key){return stored.get(key.url)?.clone();},
    async put(key,response){stored.set(key.url,response.clone());}}};
  return {stored,pending,context:{waitUntil:promise=>pending.push(promise)},
    restore(){globalThis.caches=original;}};
}

test("Repeated snapshot file requests are served from the edge without D1 or R2",async()=>{
  const f=d1Fixture(),cache=edgeCache();
  try {
    const origin=f.env.CORS_ORIGINS.split(",")[0].trim();
    const path="/catalog/data/snapshots/"+f.old.manifest.generation+"/sources.json";
    const request=(headers={Origin:origin})=>worker.fetch(
      new Request("https://api.test"+path,{headers}),f.env,cache.context);
    const cold=await request();
    assert.equal(cold.status,200);
    const body=await cold.text();
    await Promise.all(cache.pending);
    const queries=f.queryLog.length,reads=f.reads.length;

    const warm=await request();
    assert.equal(warm.status,200);
    assert.equal(await warm.text(),body);
    assert.equal(warm.headers.get("Access-Control-Allow-Origin"),origin);
    assert.equal(warm.headers.get("Cache-Control"),"public,max-age=31536000,immutable");
    const conditional=await request({Origin:origin,"If-None-Match":cold.headers.get("ETag")});
    assert.equal(conditional.status,304);
    assert.equal(f.queryLog.length,queries,"edge hits must not query D1");
    assert.equal(f.reads.length,reads,"edge hits must not read R2");

    // Each allowed origin keeps its own CORS headers.
    const other=await request({Origin:"https://other.test"});
    assert.equal(other.headers.get("Access-Control-Allow-Origin"),null);
    assert.equal(await other.text(),body);
  } finally {cache.restore();f.sqlite.close();}
});

test("Compact generation documents read digests from the manifest file index",async()=>{
  const f=d1Fixture();
  try {
    const key="generations/test.json";
    const document=JSON.parse(f.objects.get(key));
    delete document.files;
    document.extra_files={};
    f.objects.set(key,JSON.stringify(document));
    const name="sources.json";
    const response=await worker.fetch(new Request(
      "https://api.test/catalog/data/snapshots/"+f.old.manifest.generation+"/"+name),f.env);
    assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get("ETag"),'"'+document.manifest.files[name].sha256+'"');
    assert.equal(await response.text(),f.old.bodies[name]);
    assert.equal((await f.request("/health")).ok,true);
  } finally {f.sqlite.close();}
});

test("Catalog ID lookups use the primary-key record key",async()=>{
  const f=d1Fixture();
  try {
    const bundle=JSON.parse(f.old.bodies["bundles.json"])[0];
    const detail=await f.request("/bundles/"+bundle.id);
    assert.equal(detail.id,bundle.id);
    const lookups=f.queryLog.filter(sql=>sql.includes("r.record_key=?"));
    assert.ok(lookups.length,"bundle detail should match record_key");
    assert.ok(!f.queryLog.some(sql=>sql.includes("json_extract(r.data,'$.catalog_id')=?")));
  } finally {f.sqlite.close();}
});
