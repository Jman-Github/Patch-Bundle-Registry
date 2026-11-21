import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {d1Fixture} from "../worker/test/d1-fixture.js";

const f=d1Fixture(237);
const mf=new Miniflare(convertV4MiniflareOptions({
  modules:true,scriptPath:fileURLToPath(new URL("../worker/dist/index.js",import.meta.url)),
  compatibilityDate:"2026-10-07",compatibilityFlags:["nodejs_compat"],
  bindings:{CATALOG_BACKEND:"d1"},
  d1Databases:{DB:"11111111-1111-1111-1111-111111111111"},r2Buckets:["ARCHIVE"],
  durableObjects:{SUBSCRIPTIONS:{className:"CatalogSubscriptions",useSQLite:true},
    REFRESH_STATUS:{className:"RefreshStatus",useSQLite:true}}
}));
try {
  const db=await mf.getD1Database("DB"),bucket=await mf.getR2Bucket("ARCHIVE");
  for (const row of f.sqlite.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type='trigger',type='index'").all())
    await db.prepare(row.sql).run();
  for (const name of ["catalog_generations","catalog_state","catalog_records"]) {
    for (const row of f.sqlite.prepare("SELECT * FROM "+name).all()) {
      const fields=Object.keys(row);
      await db.prepare("INSERT INTO "+name+"("+fields.join(",")+") VALUES("+fields.map(()=>"?").join(",")+")")
        .bind(...Object.values(row)).run();
    }
  }
  for (const [key,body] of f.objects) await bucket.put(key,body);
  const request=async path=>{
    const response=await mf.dispatchFetch("https://api.test"+path);
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const graph=async query=>{
    const response=await mf.dispatchFetch("https://api.test/graphql",{method:"POST",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({query})});
    const result=await response.json();
    assert.equal(result.errors,undefined,JSON.stringify(result));
    return result.data;
  };
  let after=null,total=0;
  do {
    const page=await request("/history/releases?limit=100"+(after?"&after="+encodeURIComponent(after):""));
    total+=page.data.length;after=page.next_cursor;
  } while(after);
  assert.equal(total,237);
  assert.equal((await graph("{historical_releases(limit:100){data{id changelog assets} next_cursor}}")).historical_releases.data.length,100);
  assert.equal((await graph("{bundle(limit:1){id version patches(limit:2){name}}}")).bundle[0].version,"v1");
  const id="0".repeat(24),key="a".repeat(64);
  const original=JSON.stringify({id,changelog:"Original 🌍 notes\n".repeat(10000),assets:[{name:"patch.rvp"}]});
  await bucket.put("objects/"+key,original);
  const row=JSON.parse((await db.prepare("SELECT data FROM catalog_records WHERE kind='history_release' AND record_key=?").bind(id).first()).data);
  row.document_key=key;delete row.changelog;delete row.assets;
  await db.prepare("UPDATE catalog_records SET data=? WHERE kind='history_release' AND record_key=?")
    .bind(JSON.stringify(row),id).run();
  const chunks=[];let offset=0;
  do {
    const rest=await request("/history/releases/"+id+"/document?offset="+offset+"&limit=17000");
    const data=await graph('{historical_release(id:"'+id+'"){document(offset:'+offset+',limit:17000){encoding data total_bytes next_offset}}}');
    assert.deepEqual(data.historical_release.document,rest);
    chunks.push(Buffer.from(rest.data,"base64"));offset=rest.next_offset;
  } while(offset!==null);
  assert.equal(Buffer.concat(chunks).toString("utf8"),original);
  assert.equal((await request("/history/releases/"+id+"/document?offset=2000000")).data,"");
  const stale=await mf.dispatchFetch("https://api.test/history/releases?after="+encodeURIComponent(
    btoa(JSON.stringify(["f".repeat(24),"","x"]))));
  assert.equal(stale.status,409);

  const manifestPath="https://api.test/catalog/data/manifest.json";
  const first=await mf.dispatchFetch(manifestPath);
  assert.equal(first.status,200);
  assert.deepEqual(await first.json(),f.old.manifest);
  const etag=first.headers.get("ETag");
  assert.equal((await mf.dispatchFetch(manifestPath,{headers:{"If-None-Match":"W/"+etag}})).status,304);
  const next="e".repeat(24),keyNext="generations/next.json";
  const document=JSON.parse(f.objects.get("generations/test.json"));
  document.manifest.generation=next;
  document.manifest.snapshot="snapshots/"+next;
  document.padding="x".repeat(9*1024*1024);
  await bucket.put(keyNext,JSON.stringify(document));
  await db.prepare("INSERT INTO catalog_generations VALUES(2,?,?,'ready','now')")
    .bind(next,keyNext).run();
  await db.prepare("UPDATE catalog_state SET active_seq=2").run();
  const rotated=await mf.dispatchFetch(manifestPath,{headers:{"If-None-Match":etag}});
  assert.equal(rotated.status,200);
  assert.equal(rotated.headers.get("X-Catalog-Generation"),next);
  assert.deepEqual(await rotated.json(),document.manifest);
  // A GET miss should reuse resolved isolate data across actual Worker requests.
  await bucket.delete(keyNext);
  assert.equal((await request("/health?after-manifest=1")).generation,next);
  await bucket.put(keyNext,JSON.stringify(document));
  assert.deepEqual(await request("/catalog/data/snapshots/"+f.old.manifest.generation+"/sources.json"),
    JSON.parse(f.old.bodies["sources.json"]));
  console.log("D1/R2 local runtime passed: REST, GraphQL, chunked documents, generation cursors, manifest rotation and historical snapshots.");
} finally {
  f.sqlite.close();
  await mf.dispose();
}

