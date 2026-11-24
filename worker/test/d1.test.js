import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import {d1Fixture} from "./d1-fixture.js";
import {ApiCatalog} from "../../shared/api-catalog.js";

test("The changelog index reads historical releases without loading full notes", async () => {
  const catalog = new ApiCatalog("https://api.test");
  catalog.manifest = {files: {"changelogs.json": {}}};
  const source = {id:"source", url:"https://github.com/team/patches", enabled:true};
  const files = [];
  catalog.file = async name => {
    files.push(name);
    if (name === "sources.json") return [source,{id:"disabled",enabled:false}];
    assert.equal(name,"changelogs.json");
    return {columns:["id","source_id","version","bundle_type"],rows:[
      ["new","source","v2","Morphe:V1"],["old","source","v1","Morphe:V1"],
      ["disabled","disabled","v1","Morphe:V1"]
    ]};
  };
  const [rows, concurrent] = await Promise.all([catalog.changelogBundles(),catalog.changelogBundles()]);
  assert.deepEqual(rows.map(row=>row.id),["new","old"]);
  assert.equal(rows[1].source,source);
  assert.equal(rows,concurrent);
  assert.deepEqual(files,["changelogs.json","sources.json"]);
});

test("Older D1 snapshots include historical changelogs through the full bundle index", async () => {
  const catalog = new ApiCatalog("https://api.test");
  catalog.manifest = {files: {}};
  catalog.file = async name => {
    if (name === "sources.json") return [{id:"s",url:"https://github.com/a/b"}];
    assert.equal(name,"bundles.json");
    return [{id:"old",source_id:"s",description:"Older notes",is_latest:false},
      {id:"empty",source_id:"s",description:"  "},
      {id:"retired",source_id:"s",description:"Notes",availability:"unavailable"}];
  };
  assert.deepEqual((await catalog.changelogBundles()).map(row=>row.id),["old"]);
});

test("D1 REST and GraphQL page all 237 releases with identical metadata",async()=>{
  const fixture=d1Fixture(237);
  for (const order of ["asc","desc"]) {
    let cursor=null;
    const ids=[];
    do {
      const args="limit=37&order="+order+(cursor?"&after="+encodeURIComponent(cursor):"");
      const rest=await fixture.request("/history/releases?"+args);
      const graph=await fixture.graph(`{historical_releases(limit:37,order:"${order}"${cursor?',after:'+JSON.stringify(cursor):''}) {
        generation next_cursor data { id source_id source_url upstream_id name tag version
          is_prerelease draft published_at changelog release_notes assets raw_metadata
          availability binary_archived bundle_ids runtimes bundle_types }
      }}`);
      assert.equal(graph.errors,undefined,JSON.stringify(graph.errors));
      const selected=graph.data.historical_releases;
      assert.equal(selected.next_cursor,rest.next_cursor);
      for (let i=0;i<rest.data.length;i++)
        assert.deepEqual(selected.data[i],rest.data[i]);
      ids.push(...rest.data.map(row=>row.id));
      cursor=rest.next_cursor;
    } while(cursor);
    assert.equal(ids.length,237);assert.equal(new Set(ids).size,237);
  }
  const stable=await fixture.request("/history/releases?prerelease=false&limit=100");
  assert.ok(stable.data.every(row=>!row.is_prerelease));
  const id="0".repeat(24);
  const rest=await fixture.request("/history/releases/"+id);
  const graph=await fixture.graph(`{historical_release(id:"${id}"){id availability changelog assets}}`);
  assert.deepEqual(graph.data.historical_release,{
    id,availability:rest.availability,changelog:rest.changelog,assets:rest.assets});
});

test("D1 Android discovery and package relations avoid catalog shard reads",async()=>{
  const f=d1Fixture();
  const query=`{bundle(where:{is_latest:{_eq:true},source:{enabled:{_eq:true}}},
    order_by:{id:asc},limit:10){id catalog_id version description source{url}
      patches(where:{patch_packages:{package:{name:{_eq:"com.video"}}}},limit:10){
        id name patch_packages{package{name version}}
      }
    } bundle_aggregate(where:{is_latest:{_eq:true}}){aggregate{count}}}`;
  const newResult=await f.graph(query);
  const response=await worker.fetch(new Request("https://api.test/graphql",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query})
  }),f.old.env);
  assert.deepEqual(newResult,await response.json());
  assert.ok(f.queryLog.some(sql=>sql.includes("EXISTS")));
  assert.deepEqual(f.reads,["generations/test.json"]);
});

test("D1 history cursor pins generation and staging rows cannot leak",async()=>{
  const f=d1Fixture(120);
  const first=await f.request("/history/releases?limit=100");
  f.add("history_release","future",{id:"future",published_at:"2026"},2);
  assert.equal((await f.request("/history/releases?limit=100&after="+encodeURIComponent(first.next_cursor))).data.length,20);
  f.sqlite.prepare("INSERT INTO catalog_generations VALUES(2,?,'generations/test.json','ready','now')")
    .run("e".repeat(24));
  f.sqlite.exec("UPDATE catalog_state SET active_seq=2");
  const response=await worker.fetch(new Request("https://api.test/history/releases?after="+
    encodeURIComponent(first.next_cursor)),f.env);
  assert.equal(response.status,503); // deliberately mismatched R2 manifest is rejected
});

test("D1 count windows, retired relationships and app history keep equivalent coverage",async()=>{
  const f=d1Fixture();
  const counts=await f.graph('{bundle_aggregate(limit:1){aggregate{count(columns:[source_fk],distinct:true)} nodes{id}}}');
  assert.equal(counts.errors,undefined,JSON.stringify(counts));
  assert.equal(counts.data.bundle_aggregate.aggregate.count,1);
  f.sqlite.exec("UPDATE catalog_records SET data=json_set(data,'$.enabled',json('false')) WHERE kind='source'");
  assert.equal((await f.graph("{bundle{ id }}")).data.bundle.length,0);
  const archived=await f.graph('{historical_patches(limit:100){id bundle{catalog_id} patch_packages{package{name version}}}}');
  assert.equal(archived.errors,undefined,JSON.stringify(archived));
  assert.equal(archived.data.historical_patches.length,2);
  assert.equal(archived.data.historical_patches[0].patch_packages.length,2);
  const mixed=await f.graph('{source(where:{url:{_regex:"github"}}){id} historical_patches(limit:1){id bundle{catalog_id} patch_packages{package{name}}}}');
  assert.equal(mixed.errors,undefined,JSON.stringify(mixed));
  assert.equal(mixed.data.historical_patches[0].patch_packages.length,2);
  f.add("app","com.video",{package_name:"com.video",app_name:"Video"});
  const rest=await f.request("/history/apps");
  const graph=await f.graph("{historical_apps(limit:100)}");
  assert.deepEqual(graph.data.historical_apps,rest.data);
  f.sqlite.close();
});

test("API frontend pages source history once and loads details on demand",async()=>{
  const {ApiCatalog}=await import("../../shared/api-catalog.js");
  const original=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async input=>{
    const url=new URL(input);calls.push(url);
    if(url.pathname.endsWith("/manifest.json")) return Response.json({schema_version:1,generation:"d".repeat(24),snapshot:"snapshots/"+"d".repeat(24),files:{}});
    if(url.pathname==="/catalog/bundles") {
      const offset=Number(url.searchParams.get("offset"));
      const count=url.searchParams.has("source")?237:2;
      return Response.json({data:Array.from({length:Math.min(100,count-offset)},(_,i)=>({id:String(offset+i)}))});
    }
    throw new Error("Unexpected eager fetch: "+url);
  };
  try {
    const api=await new ApiCatalog("https://api.test").initialize();
    assert.equal((await api.bundles()).length,2);
    const [a,b]=await Promise.all([api.historyBundles("https://github.com/owner/repo"),api.historyBundles("https://github.com/owner/repo")]);
    assert.equal(a.length,237);assert.deepEqual(a,b);
    await api.historyBundles("https://github.com/owner/repo");
    assert.equal(calls.filter(url=>url.searchParams.has("source")).length,3);
  } finally {globalThis.fetch=original;}
});


test("D1 keeps REST source aliases, case-insensitive imports, patch links and bundle app details",async()=>{
  const f=d1Fixture();
  const {createHash}=await import("node:crypto");
  const put=(name,value)=>{
    const body=JSON.stringify(value),digest=createHash("sha256").update(body).digest("hex");
    f.old.bodies[name]=body;
    const metadata={bytes:Buffer.byteLength(body),sha256:digest};
    f.old.manifest.files[name]=metadata;
    f.objects.set("objects/"+digest,body);
    const document=JSON.parse(f.objects.get("generations/test.json"));
    document.files[name]=digest;document.manifest.files[name]=metadata;
    f.objects.set("generations/test.json",JSON.stringify(document));
  };
  const sources=JSON.parse(f.old.bodies["sources.json"]);
  sources[0].url="https://github.com/Owner/Repo";
  put("sources.json",sources);
  f.sqlite.prepare("UPDATE catalog_records SET data=json_set(data,'$.url',?) WHERE kind='source'")
    .run(sources[0].url);
  put("bundle-apps/"+f.old.bundle.id+".json",[{package_name:"com.video",app_name:"Video",versions:["1.0"],patch_count:1}]);
  function contains(actual,expected) {
    if(expected && typeof expected==="object") {
      for(const key of Object.keys(expected)) {assert.ok(Object.hasOwn(actual,key),"missing "+key);contains(actual[key],expected[key]);}
    } else assert.deepEqual(actual,expected);
  }
  for(const path of ["/bundles?source=demo","/bundles?source_url=https://github.com/owner/repo",
    "/sources?source_url=https://github.com/owner/repo",
    "/bundles/"+f.old.bundle.id,"/patches?bundle_id="+f.old.bundle.id,
    "/api/v3/bundle?source_url=https://github.com/owner/repo&version=latest&channel=stable"]) {
    const response=await worker.fetch(new Request("https://api.test"+path),f.old.env);
    const old=await response.json();
    assert.equal(response.status,200,JSON.stringify(old));
    contains(await f.request(path),old);
  }
  f.sqlite.close();
});


test("Historical publication ordering compares instants and retains original timezone spelling",async()=>{
  const f=d1Fixture();
  const early="1".repeat(24),late="2".repeat(24);
  for(const [id,date] of [[early,"2026-01-01T01:00:00+02:00"],[late,"2025-12-31T23:30:00Z"]])
    f.add("history_release",id,{id,source_id:"s1",source_url:"https://github.com/owner/repo",
      is_prerelease:false,draft:false,availability:"available",binary_archived:false,
      published_at:date,bundle_ids:[],runtimes:[],bundle_types:[]});
  const first=await f.request("/history/releases?limit=1");
  assert.equal(first.data[0].id,early);
  assert.equal(first.data[0].published_at,"2026-01-01T01:00:00+02:00");
  const second=await f.request("/history/releases?limit=1&after="+encodeURIComponent(first.next_cursor));
  assert.equal(second.data[0].id,late);assert.equal(second.next_cursor,null);
  const graph=await f.graph('{historical_releases(from:"2025-12-31T23:15:00Z"){data{id published_at}}}');
  assert.deepEqual(graph.data.historical_releases.data,[{id:late,published_at:"2025-12-31T23:30:00Z"}]);
  f.sqlite.close();
});


test("Entity history pagination rejects generation changes in both protocols",async()=>{
  const f=d1Fixture();
  const generation=f.old.manifest.generation;
  const first=await f.request("/history/patches?limit=1");
  assert.equal(first.generation,generation);
  const next="e".repeat(24);
  const document=JSON.parse(f.objects.get("generations/test.json"));
  document.manifest.generation=next;
  f.objects.set("generations/test.json",JSON.stringify(document));
  f.sqlite.prepare("UPDATE catalog_generations SET generation=?").run(next);
  const rest=await worker.fetch(new Request("https://api.test/history/patches?generation="+generation),f.env);
  assert.equal(rest.status,409);
  const graph=await f.graph('{catalog_generation historical_patches(generation:"'+generation+'"){id}}');
  assert.ok(graph.errors.some(row=>row.message.includes("Catalog changed")));
  f.sqlite.close();
});

test("Operator verifier traverses complete REST/GraphQL release and entity histories",async()=>{
  const {verifyHistoryApi}=await import("../../scripts/verify_history_api.mjs");
  const f=d1Fixture(237);
  const result=await verifyHistoryApi("https://api.test",null,(url,options)=>
    worker.fetch(new Request(url,options),f.env));
  assert.equal(result.releases,237);
  assert.equal(result.prereleases,118);
  assert.equal(result.entities.patches,2);
  assert.equal(result.entities["patch-packages"],4);
  f.sqlite.close();
});


test("Operator verification reduces oversized REST and GraphQL pages without losing history",async()=>{
  const {verifyHistoryApi}=await import("../../scripts/verify_history_api.mjs");
  const f=d1Fixture(237);
  let restRetries=0,graphRetries=0;
  const result=await verifyHistoryApi("https://api.test",null,(url,options)=>{
    const path=new URL(url);
    if(path.pathname.startsWith("/history/") && Number(path.searchParams.get("limit"))>13) {
      restRetries++;return Response.json({error:"Response too large"},{status:422});
    }
    if(path.pathname==="/graphql" && JSON.parse(options.body).variables.limit>6) {
      graphRetries++;return Response.json({error:"Response too large"},{status:422});
    }
    return worker.fetch(new Request(url,options),f.env);
  });
  assert.equal(result.releases,237);
  assert.equal(result.entities.patches,2);
  assert.ok(restRetries>0);assert.ok(graphRetries>0);
  f.sqlite.close();
});

test("Frontend reduces oversized history pages and retains every version",async()=>{
  const {ApiCatalog}=await import("../../shared/api-catalog.js");
  const original=globalThis.fetch;let retries=0;
  globalThis.fetch=async input=>{
    const url=new URL(input),limit=Number(url.searchParams.get("limit"));
    if(limit>25) {retries++;return Response.json({error:"Response too large"},{status:422});}
    const offset=Number(url.searchParams.get("offset"));
    return Response.json({data:Array.from({length:Math.min(limit,237-offset)},
      (_,i)=>({id:String(offset+i)}))});
  };
  try {
    const api=new ApiCatalog("https://api.test");
    api.manifest={generation:"d".repeat(24)};
    const rows=await api.historyBundles("https://github.com/owner/repo");
    assert.equal(rows.length,237);
    assert.equal(new Set(rows.map(row=>row.id)).size,237);
    assert.equal(retries,2);
  } finally {globalThis.fetch=original;}
});

test("D1 bundle detail hides disabled sources while history stays available",async()=>{
  const f=d1Fixture();
  f.sqlite.exec("UPDATE catalog_records SET data=json_set(data,'$.enabled',json('false')) WHERE kind='source'");
  for(const prefix of ["","/api/v1"]) {
    const response=await worker.fetch(new Request("https://api.test"+prefix+"/bundles/"+f.old.bundle.id),f.env);
    assert.equal(response.status,404);
  }
  const history=await f.request("/history/bundles?limit=100");
  assert.ok(history.data.some(row=>row.id===f.old.bundle.id));
  f.sqlite.close();
});

test("D1 falls back before combined filters exceed its parameter limit",async()=>{
  const f=d1Fixture();
  const ids=Array.from({length:60},(_,i)=>i+1).join(",");
  const query="{bundle(where:{_and:[{id:{_in:["+ids+"]}},{source_fk:{_in:["+ids+"]}}]}){id}}";
  const response=await worker.fetch(new Request("https://api.test/graphql",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query})
  }),f.old.env);
  const expected=await response.json();
  assert.equal(expected.errors,undefined);
  assert.deepEqual(await f.graph(query),expected);
  f.sqlite.close();
});

test("API patch pagination flags a changed generation for automatic recovery",async()=>{
  const {ApiCatalog}=await import("../../shared/api-catalog.js");
  const original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({error:"Catalog changed"},{status:409});
  try {
    const api=new ApiCatalog("https://api.test");
    api.manifest={generation:"d".repeat(24)};
    await assert.rejects(api.patchRows({bundle_id:"a".repeat(24)}),
      error=>error.status===409 && error.generationUnavailable===true);
  } finally {globalThis.fetch=original;}
});

test("API bootstrap restores remembered source history without fetching unrelated histories",async()=>{
  const {ApiCatalog}=await import("../../shared/api-catalog.js");
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async input=>{
    const url=new URL(input);calls.push(url);
    assert.equal(url.pathname,"/catalog/bundles");
    return Response.json({data:url.searchParams.has("source")?
      [{id:"new",version:"v2"},{id:"old",version:"v1"}]:[{id:"new",version:"v2"}]});
  };
  try {
    const api=new ApiCatalog("https://api.test");
    api.manifest={generation:"d".repeat(24)};
    const source="https://github.com/owner/repo";
    const rows=await api.bundles({sources:[source,source]});
    assert.deepEqual(rows.map(row=>row.version),["v2","v1"]);
    assert.equal(calls.length,2);
    assert.equal(calls[1].searchParams.get("source"),source);
    await api.bundles({sources:[source]});
    assert.equal(calls.length,2);
  } finally {globalThis.fetch=original;}
});

test("Historical entity filters reject malformed numeric values",async()=>{
  const f=d1Fixture();
  for(const [path,message] of [["/history/patches?patch_fk=abc","patch_fk"],
    ["/history/bundles?source_fk=-2","source_fk"],["/history/packages?package_fk=1.5","package_fk"],
    ["/history/patch-packages?patch_fk=","patch_fk"]]) {
    const response=await worker.fetch(new Request("https://api.test"+path),f.env);
    assert.equal(response.status,400,path);
    assert.match((await response.json()).error,new RegExp("Invalid "+message+" filter"));
  }
  const valid=await worker.fetch(new Request("https://api.test/history/patches?bundle_fk=1"),f.env);
  assert.equal(valid.status,200,await valid.clone().text());
  f.sqlite.close();
});

test("Transient catalog detail failures can retry instead of sticking to the session",async()=>{
  const {ApiCatalog}=await import("../../shared/api-catalog.js");
  const original=globalThis.fetch;
  const id="a".repeat(24);
  let details=0;
  globalThis.fetch=async input=>{
    const url=new URL(input);
    if(url.pathname.endsWith("/manifest.json"))
      return Response.json({schema_version:1,generation:"d".repeat(24),
        snapshot:"snapshots/"+"d".repeat(24),files:{}});
    assert.equal(url.pathname,"/bundles/"+id);
    details++;
    if(details<=3) return Response.json({error:"Temporary failure"},{status:503});
    return Response.json({id,description:"Release notes"},
      {headers:{"X-Catalog-Generation":"d".repeat(24)}});
  };
  try {
    const api=await new ApiCatalog("https://api.test").initialize();
    await assert.rejects(api.file("bundles/"+id+".json"),error=>error.status===503 && !error.generationUnavailable);
    const detail=await api.file("bundles/"+id+".json");
    assert.equal(detail.description,"Release notes");
    assert.equal(details,4);
  } finally {globalThis.fetch=original;}
});

test("D1 catalog file reads retry after a transient archive failure",async()=>{
  const f=d1Fixture();
  const {D1Catalog}=await import("../src/d1-catalog.js");
  const catalog=await new D1Catalog(f.env).initialize();
  const name=Object.keys(catalog.manifest.files)[0];
  const key="objects/"+catalog.document.files[name];
  const original=f.env.ARCHIVE.get.bind(f.env.ARCHIVE);
  let reads=0;
  f.env.ARCHIVE.get=async requested=>{
    if(requested===key && (reads+=1)===1) return null;
    return original(requested);
  };
  await assert.rejects(catalog.file(name),/Catalog object unavailable/);
  assert.deepEqual(await catalog.file(name),JSON.parse(f.objects.get(key)));
  assert.equal(reads,2);
  f.sqlite.close();
});

test("Operator verifier retries temporary failures on the same REST and GraphQL page",async()=>{
  const {verifyHistoryApi}=await import("../../scripts/verify_history_api.mjs");
  const f=d1Fixture(30),waits=[],logs=[],failures=new Map(),retried=[];
  const result=await verifyHistoryApi("https://api.test",null,async(url,options)=>{
    const parsed=new URL(url),body=options?.body && JSON.parse(options.body);
    const rest=parsed.pathname==="/history/releases" && parsed.searchParams.has("after");
    const graph=parsed.pathname==="/graphql" && body.query.includes("historical_patches(");
    if(rest || graph) {
      const key=JSON.stringify([url,options?.body]),attempt=failures.get(key)??0;
      failures.set(key,attempt+1);
      if(attempt===0) {
        retried.push(key);
        return Response.json({error:"Temporary upstream failure"},{status:rest?429:503,
          headers:{"Retry-After":"2"}});
      }
    }
    return worker.fetch(new Request(url,options),f.env);
  },null,{wait:async delay=>waits.push(delay),log:message=>logs.push(message)});
  assert.equal(result.releases,30);
  assert.equal(result.entities.patches,2);
  assert.equal(retried.length,2);
  assert.deepEqual(waits,[2000,2000]);
  assert.ok(retried.every(key=>failures.get(key)===2));
  assert.ok(logs.some(line=>line.includes("patches offset=0 limit=25")));
  f.sqlite.close();
});

test("Operator verifier bounds retries and reports the failed entity page",async()=>{
  const {verifyHistoryApi}=await import("../../scripts/verify_history_api.mjs");
  const f=d1Fixture(),waits=[];
  let failures=0;
  try {
    await assert.rejects(verifyHistoryApi("https://api.test",null,(url,options)=>{
      if(new URL(url).pathname==="/graphql" &&
          JSON.parse(options.body).query.includes("historical_patches(")) {
        failures++;
        return Response.json({error:"D1 unavailable"},{status:503});
      }
      return worker.fetch(new Request(url,options),f.env);
    },null,{wait:async delay=>waits.push(delay),log:()=>{}}),
    /HTTP 503 at \/graphql \(patches offset=0 limit=25\): D1 unavailable/);
    assert.equal(failures,4);
    assert.deepEqual(waits,[1000,2000,4000]);
  } finally {f.sqlite.close();}
});

test("Operator verifier never retries permanent HTTP errors",async()=>{
  const {verifyHistoryApi}=await import("../../scripts/verify_history_api.mjs");
  let calls=0;
  await assert.rejects(verifyHistoryApi("https://api.test",null,()=>{
    calls++;
    return Response.json({error:"Wrong API route"},{status:404});
  },null,{wait:async()=>assert.fail("Permanent errors must not retry"),log:()=>{}}),/HTTP 404/);
  assert.equal(calls,1);
});

test("Operator verifier honors HTTP-date Retry-After without retrying early",async()=>{
  const {verifyHistoryApi}=await import("../../scripts/verify_history_api.mjs");
  const deadline=new Date(Math.ceil(Date.now()/1000)*1000+60000).toUTCString();
  let calls=0;
  await assert.rejects(verifyHistoryApi("https://api.test",null,()=>{
    calls++;
    return Response.json({error:"Cooling down"},{status:503,headers:{"Retry-After":deadline}});
  },null,{wait:async delay=>{
    assert.ok(delay>0);
    assert.ok(Date.now()+delay>=Date.parse(deadline));
    throw new Error("Observed server-requested delay");
  },log:()=>{}}),/Observed server-requested delay/);
  assert.equal(calls,1);
});

for(const phase of ["connect","body","timeout"])test("Operator verifier retries temporary network failures during "+phase,async()=>{
  const {verifyHistoryApi}=await import("../../scripts/verify_history_api.mjs");
  const f=d1Fixture(),waits=[],attempts=[];
  try {
    const result=await verifyHistoryApi("https://api.test",null,(url,options)=>{
      if(new URL(url).pathname==="/graphql" &&
          JSON.parse(options.body).query.includes("historical_patches(")) {
        attempts.push(options.body);
        if(attempts.length===1) {
          const error=phase==="timeout"?new DOMException("Request timed out","TimeoutError"):
            new TypeError("fetch failed",{cause:Object.assign(new Error("reset"),{code:"ECONNRESET"})});
          if(phase!=="body")throw error;
          return {ok:true,json:async()=>{throw error;}};
        }
      }
      return worker.fetch(new Request(url,options),f.env);
    },null,{wait:async delay=>waits.push(delay),log:()=>{}});
    assert.equal(result.entities.patches,2);
    assert.equal(attempts.length,2);
    assert.equal(attempts[0],attempts[1]);
    assert.deepEqual(waits,[1000]);
  } finally {f.sqlite.close();}
});

test("Operator verifier bounds network retries and preserves page context",async()=>{
  const {verifyHistoryApi}=await import("../../scripts/verify_history_api.mjs");
  let calls=0;
  await assert.rejects(verifyHistoryApi("https://api.test",null,()=>{
    calls++;
    throw new TypeError("fetch failed",{cause:Object.assign(new Error("reset"),{code:"ECONNRESET"})});
  },null,{wait:async()=>{},log:()=>{}}),/request failed at \/history\/releases .*ECONNRESET/);
  assert.equal(calls,4);
});

test("Operator verifier does not retry certificate failures",async()=>{
  const {verifyHistoryApi}=await import("../../scripts/verify_history_api.mjs");
  let calls=0;
  await assert.rejects(verifyHistoryApi("https://api.test",null,()=>{
    calls++;
    throw new TypeError("fetch failed",{cause:{code:"ERR_TLS_CERT_ALTNAME_INVALID"}});
  },null,{wait:async()=>assert.fail("Certificate failures must not retry"),log:()=>{}}),/ERR_TLS_CERT_ALTNAME_INVALID/);
  assert.equal(calls,1);
});

test("API smoke samples first middle and last pages with explicit partial coverage",async()=>{
  const {verifyHistoryApi}=await import("../../scripts/verify_history_api.mjs");
  const f=d1Fixture(237),offsets=[];
  const template=JSON.parse(f.sqlite.prepare("SELECT data FROM catalog_records WHERE kind='patch' LIMIT 1").get().data);
  for(let i=0;i<237;i++) {
    const id=(i+1000).toString(16).padStart(24,"0");
    f.add("patch",id,{...template,id:i+1000,catalog_id:id});
  }
  try {
    const result=await verifyHistoryApi("https://api.test",null,(url,options)=>{
      const parsed=new URL(url);
      if(parsed.pathname==="/history/patches")offsets.push(Number(parsed.searchParams.get("offset")));
      return worker.fetch(new Request(url,options),f.env);
    },null,{mode:"smoke",log:()=>{}});
    assert.equal(result.mode,"smoke");assert.equal(result.coverage,"sampled");
    assert.equal(result.releases,50);assert.equal(result.releases_complete,false);
    assert.deepEqual(offsets,[0,100,225]);
    assert.equal(result.entities.patches,239);
    assert.equal(result.entity_rows_checked.patches,64);
    assert.ok(result.requests<50);
  } finally {f.sqlite.close();}
});

for(const [protocol,threshold] of [["REST",100],["REST",200],["GraphQL",100],["GraphQL",200]])
test("API smoke retains the final rows after "+protocol+" page resizing at "+threshold,async()=>{
  const {verifyHistoryApi}=await import("../../scripts/verify_history_api.mjs");
  const f=d1Fixture(),pages=[];
  const template=JSON.parse(f.sqlite.prepare("SELECT data FROM catalog_records WHERE kind='patch' LIMIT 1").get().data);
  for(let i=0;i<237;i++) {
    const id=(i+1000).toString(16).padStart(24,"0");
    f.add("patch",id,{...template,id:i+1000,catalog_id:id});
  }
  try {
    const result=await verifyHistoryApi("https://api.test",null,(url,options)=>{
      const parsed=new URL(url),offset=Number(parsed.searchParams.get("offset"));
      if(parsed.pathname==="/history/patches") {
        const limit=Number(parsed.searchParams.get("limit"));
        pages.push({offset,limit});
        if(protocol==="REST" && offset>=threshold && limit>13)
          return Response.json({error:"Response too large"},{status:422});
      }
      if(protocol==="GraphQL" && options?.body) {
        const {query,variables}=JSON.parse(options.body);
        if(query.includes("historical_patches(") && variables.offset>=threshold && variables.limit>13)
          return Response.json({error:"Response too large"},{status:422});
      }
      return worker.fetch(new Request(url,options),f.env);
    },null,{mode:"smoke",log:()=>{}});
    const expected=threshold===100?[{offset:0,limit:25},{offset:100,limit:25},
      {offset:100,limit:13},{offset:234,limit:13}]:[{offset:0,limit:25},{offset:100,limit:25},
      {offset:225,limit:25},{offset:234,limit:13}];
    assert.deepEqual(pages,expected);
    assert.equal(result.entity_rows_checked.patches,threshold===100?43:55);
  } finally {f.sqlite.close();}
});


test("large D1 manifest bootstraps the website while query responses stay bounded",async()=>{
  const f=d1Fixture(2);
  try {
    const document=JSON.parse(f.objects.get("generations/test.json"));
    for(let i=0;i<20000;i++) document.manifest.files["bundle-apps/"+i.toString(16).padStart(24,"0")+".json"]={
      bytes:1234,sha256:"a".repeat(64)
    };
    assert.ok(Buffer.byteLength(JSON.stringify(document.manifest))>2*1024*1024);
    f.objects.set("generations/test.json",JSON.stringify(document));
    const origin="https://patch-bundles.jmancentral.com";
    f.env.CORS_ORIGINS=origin;
    const url="https://api.test/catalog/data/manifest.json";
    const response=await worker.fetch(new Request(url,{headers:{Origin:origin}}),f.env);
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(await response.json(),document.manifest);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"),origin);
    assert.equal(response.headers.get("X-Catalog-Generation"),document.manifest.generation);
    assert.equal(response.headers.get("Cache-Control"),"public, max-age=60");
    const conditional=await worker.fetch(new Request(url,{headers:{Origin:origin,
      "If-None-Match":response.headers.get("ETag")}}),f.env);
    assert.equal(conditional.status,304);
    assert.equal(await conditional.text(),"");
    assert.equal(conditional.headers.get("Access-Control-Allow-Origin"),origin);
    assert.equal(conditional.headers.get("X-Catalog-Generation"),document.manifest.generation);
    const {ApiCatalog}=await import("../../shared/api-catalog.js");
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(url,options)=>worker.fetch(new Request(url,options),f.env);
    try {
      const catalog=await new ApiCatalog("https://api.test").initialize();
      assert.equal(catalog.manifest.generation,document.manifest.generation);
      assert.ok((await catalog.bundles()).length>0);
      assert.ok((await catalog.apps()).length>0);
    } finally {globalThis.fetch=originalFetch;}
    f.sqlite.prepare("UPDATE catalog_records SET data=json_set(data,'$.changelog',?) WHERE kind='history_release'")
      .run("x".repeat(1100000));
    const oversized=await worker.fetch(new Request("https://api.test/history/releases?limit=2"),f.env);
    assert.equal(oversized.status,422);
    assert.match((await oversized.json()).error,/Response too large/);
  } finally {f.sqlite.close();}
});
