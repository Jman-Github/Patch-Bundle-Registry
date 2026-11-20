import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";
import {ApiCatalog} from "../../shared/api-catalog.js";
import {patchMatchesSearch,patchDisplayName,reseamInternalSearchAlias} from "../../shared/site.js";
import {d1Fixture} from "./d1-fixture.js";

test("Bundle summaries omit repeated inventories and load full changelogs on demand",async()=>{
  const f=d1Fixture();
  try {
    f.sqlite.exec("UPDATE catalog_records SET data=json_set(data,'$.bundles',json('["+Array.from({length:800},(_,i)=>JSON.stringify("bundle"+i)).join(",")+"]')) WHERE kind='source'");
    const page=await f.request("/catalog/bundles?limit=100&generation="+f.old.manifest.generation);
    assert.equal(page.total,page.data.length);
    assert.ok(page.data.every(b=>!("bundles" in b.source)));
    assert.ok(page.data.every(b=>!b.description || b.description==="Available"));
    const detail=await f.request("/bundles/"+f.old.bundle.id);
    assert.equal(detail.description,f.old.bundle.description);
    assert.ok(detail.source.bundles.length>=800);
  } finally {f.sqlite.close();}
});

test("Bundle pages load concurrently in order, share bootstrap and obey a three-request cap",async()=>{
  const original=globalThis.fetch;
  let active=0, peak=0;
  const calls=[];
  globalThis.fetch=async input=>{
    const u=new URL(input), offset=Number(u.searchParams.get("offset")),limit=Number(u.searchParams.get("limit"));
    calls.push(offset);peak=Math.max(peak,++active);
    await new Promise(resolve=>setTimeout(resolve,offset===100?20:5));
    active--;
    return Response.json({total:650,data:Array.from({length:Math.min(limit,650-offset)},(_,i)=>({id:offset+i}))});
  };
  try {
    const api=new ApiCatalog("https://api.test");api.manifest={generation:"a".repeat(24)};
    const [a,b]=await Promise.all([api.bundles(),api.bundles()]);
    assert.deepEqual(a.map(row=>row.id),Array.from({length:650},(_,i)=>i));
    assert.deepEqual(a,b);assert.equal(peak,3);assert.equal(calls.length,7);
    await api.bundles();assert.equal(calls.length,7);
  } finally {globalThis.fetch=original;}
});

test("Parallel bundle pagination splits oversized pages without dropping or duplicating rows",async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async input=>{
    const u=new URL(input),offset=Number(u.searchParams.get("offset")),limit=Number(u.searchParams.get("limit"));
    if (limit>17) return Response.json({error:"Response too large"},{status:422});
    return Response.json({total:237,data:Array.from({length:Math.max(0,Math.min(limit,237-offset))},(_,i)=>({id:offset+i}))});
  };
  try {
    const api=new ApiCatalog("https://api.test");api.manifest={generation:"a".repeat(24)};
    assert.deepEqual((await api.bundles()).map(row=>row.id),Array.from({length:237},(_,i)=>i));
  } finally {globalThis.fetch=original;}
});

test("Failed parallel bootstrap is discarded and can be retried",async()=>{
  const original=globalThis.fetch;let fail=true;
  globalThis.fetch=async input=>{
    const offset=Number(new URL(input).searchParams.get("offset"));
    if (fail && offset===100) return Response.json({error:"Catalog changed"},{status:409});
    return Response.json({total:200,data:Array.from({length:100},(_,i)=>({id:offset+i}))});
  };
  try {
    const api=new ApiCatalog("https://api.test");api.manifest={generation:"a".repeat(24)};
    await assert.rejects(api.bundles(),e=>e.generationUnavailable);
    assert.deepEqual(api.bundleRows,[]);
    fail=false;
    assert.equal((await api.bundles()).length,200);
  } finally {globalThis.fetch=original;}
});

test("Internal display labels are searchable without replacing publisher names",()=>{
  assert.ok(patchMatchesSearch({name:null,display_name:"Enable Android Debugging Patch"},"Android debugging"));
  assert.ok(patchMatchesSearch({name:"Hide ads",display_name:"Helper"},"Hide ads"));
});

test("Patch headings fall back from whitespace names while preserving publisher titles",()=>{
  for (const name of [null,undefined,"","  ","\t\n"]) {
    assert.equal(patchDisplayName({name,display_name:"Enable Android Debugging Patch"}),
      "Enable Android Debugging Patch");
  }
  assert.equal(patchDisplayName({name:"  Hide ads  ",display_name:"Helper"}),"  Hide ads  ");
  assert.equal(patchDisplayName({name:" ",display_name:"\t"}),"Name unavailable");
  assert.equal(patchDisplayName({name:null,hidden:true}),"Internal patch");
});

test("Reseam internal IDs render readable labels without changing patch identity",()=>{
  const settings={name:"app.reseam.patches.tiktok.core.tiktokSettings",hidden:true};
  const filter={name:"app.reseam.patches.tiktok.feed.feedFilter",hidden:true};
  assert.equal(patchDisplayName(settings),"TikTok Settings");
  assert.equal(patchDisplayName(filter),"Feed Filter");
  assert.ok(patchMatchesSearch(filter,"Feed Filter"));
  assert.ok(patchMatchesSearch(settings,"TikTok Settings"));
  assert.equal(settings.name,"app.reseam.patches.tiktok.core.tiktokSettings");
  assert.equal(patchDisplayName({...settings,display_name:"TikTok settings override"}),"TikTok settings override");
  assert.equal(patchDisplayName({...settings,hidden:false}),settings.name);
  assert.equal(patchDisplayName({name:"Hide ads",hidden:true}),"Hide ads");
});

test("Reseam Browse search generates bounded index aliases for readable internal labels",()=>{
  assert.equal(reseamInternalSearchAlias("Feed Filter"),"feedfilter");
  assert.equal(reseamInternalSearchAlias("TikTok Settings"),"tiktoksettings");
  assert.equal(reseamInternalSearchAlias("Filter"),null);
  assert.equal(reseamInternalSearchAlias("Settings   "),null);
  assert.equal(reseamInternalSearchAlias("Feed / Filter"),null);
  assert.equal(reseamInternalSearchAlias("x ".repeat(100)),null);
});

test("Browse includes Reseam internal patches found by readable-name search alias",async()=>{
  const source=await readFile(new URL("../../web/app.js",import.meta.url),"utf8");
  const code=source.slice(source.indexOf("async function renderFilteredBundles("),
    source.indexOf("\nfunction renderFilteredApps("));
  const bundle={id:"reseam-release",bundleType:"Reseam",version:"v0.37.0"};
  const calls=[];
  const env={currentTab:"bundles",currentSearchQuery:"feed filter",currentPackageFilter:"",
    currentSourceUrl:"",currentBundleType:"",currentBundleVersion:"",currentFilter:"latest",
    allBundles:[bundle],filteredBundles:[],searchSequence:0,status:{textContent:""},resetFilters:{hidden:true},
    resetResultsScroll(){},saveBrowsePreferences(){},setupVirtualizer(){},updateStatus(){},
    matchesReleaseFilter(){return true;},reseamInternalSearchAlias,patchDisplayName,
    transformPatch:patch=>({...patch,compatiblePackages:[]}),
    catalog:{async patchRows(args){
      calls.push({q:args.q,ids:args.bundle_ids});
      return {rows:args.q==="feedfilter" ? [{id:"patch-id",bundle_id:bundle.id,
        name:"app.reseam.patches.tiktok.feed.feedFilter",description:"",packages:[],hidden:true}] : [],
        next_cursor:null};
    }}
  };
  runInNewContext(code+"\nthis.runBrowse=renderFilteredBundles;",env);
  await env.runBrowse();
  assert.deepEqual(calls.map(call=>call.q),["feed filter","feedfilter"]);
  assert.equal(calls[1].ids.length,1);
  assert.equal(env.filteredBundles.length,1);
  assert.equal(env.filteredBundles[0].patches.length,1);
  assert.equal(patchDisplayName(env.filteredBundles[0].patches[0]),"Feed Filter");

  const ordinaryCalls=[];
  const ordinary={...env,searchSequence:0,filteredBundles:[],
    catalog:{async patchRows(args){
      ordinaryCalls.push(args.q);
      return {rows:[{id:"named",bundle_id:bundle.id,name:"Feed filter",
        description:"",packages:[],hidden:false}],next_cursor:null};
    }}};
  runInNewContext(code+"\nthis.runBrowse=renderFilteredBundles;",ordinary);
  await ordinary.runBrowse();
  assert.deepEqual(ordinaryCalls,["feed filter","feedfilter"]);
  assert.equal(ordinary.filteredBundles[0].patches.length,1);

  // A normal hit from another publisher must not suppress the internal Reseam hit.
  const otherBundle={id:"ordinary-release",bundleType:"ReVanced:v22",version:"v1"};
  const mixed={...env,searchSequence:0,filteredBundles:[],allBundles:[bundle,otherBundle],
    catalog:{async patchRows(args){
      return {rows:args.q==="feed filter" ? [{id:"public-patch",bundle_id:otherBundle.id,
        name:"Feed filter",description:"",packages:[],hidden:false}] :
        [{id:"internal-patch",bundle_id:bundle.id,
          name:"app.reseam.patches.tiktok.feed.feedFilter",description:"",packages:[],hidden:true}],
        next_cursor:null};
    }}};
  runInNewContext(code+"\nthis.runBrowse=renderFilteredBundles;",mixed);
  await mixed.runBrowse();
  assert.deepEqual(mixed.filteredBundles.map(item=>item.id),[bundle.id,otherBundle.id]);
  assert.equal(mixed.filteredBundles[0].patches.length,1);

  const spaced={...env,searchSequence:0,filteredBundles:[],currentSearchQuery:"feed  filter"};
  runInNewContext(code+"\nthis.runBrowse=renderFilteredBundles;",spaced);
  await spaced.runBrowse();
  assert.equal(spaced.filteredBundles[0].patches.length,1);
});

test("A missing public name does not turn a patch into an internal patch",async()=>{
  const source = await readFile(new URL("../../web/app.js",import.meta.url),"utf8");
  const code = source.slice(source.indexOf("function transformPatch("),source.indexOf("\nasync function bundlePatches("));
  const context = {};
  runInNewContext(code,context);
  assert.equal(context.transformPatch({name:null,packages:[]}).hidden,false);
  assert.equal(context.transformPatch({name:null,hidden:true,packages:[]}).hidden,true);
});
