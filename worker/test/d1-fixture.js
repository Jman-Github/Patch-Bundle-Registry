import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.js";
import { fixture } from "./fixture.js";

const hash = value => createHash("sha256").update(value).digest("hex");
export function d1Fixture(historyCount = 0) {
  const old = fixture();
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_catalog.sql",import.meta.url),"utf8"));
  const queryLog = [];
  const db = {prepare(sql) {
    let values = [];
    const statement = {
      bind(...args) {values=args;return statement;},
      async all() {queryLog.push(sql);return {results:sqlite.prepare(sql).all(...values)};},
      async first() {queryLog.push(sql);return sqlite.prepare(sql).get(...values) ?? null;}
    };
    return statement;
  }};
  const objects = new Map();
  const manifest = {...old.manifest};
  const document = {manifest,files:{}};
  for (const [name,body] of Object.entries(old.bodies)) {
    document.files[name]=hash(body);objects.set("objects/"+hash(body),body);
  }
  objects.set("generations/test.json",JSON.stringify(document));
  sqlite.prepare("INSERT INTO catalog_generations VALUES(1,?,'generations/test.json','ready','now')")
    .run(manifest.generation);
  sqlite.exec("UPDATE catalog_state SET active_seq=1");
  function add(kind,key,data,seq=1) {
    sqlite.prepare("INSERT INTO catalog_records VALUES(?,?,?,NULL,?,?)")
      .run(kind,key,seq,JSON.stringify(data),hash(JSON.stringify(data)));
  }
  const source = JSON.parse(old.bodies["sources.json"])[0];
  add("source",source.id,{...source,id:1,catalog_id:source.id});
  add("source_metadata",source.id,{...source.source_metadatum,id:1,source_fk:1});
  for (const bundle of JSON.parse(old.bodies["bundles.json"]))
    add("bundle",bundle.id,{...bundle,id:bundle.legacy_id,catalog_id:bundle.id,source_fk:1});
  for (const patch of JSON.parse(old.bodies["patches/00000.json"])) {
    add("patch",patch.id,{...patch,id:patch.legacy_id,catalog_id:patch.id,bundle_fk:patch.legacy_id});
    for (let id=1;id<=2;id++) add("patch_package",patch.id+":"+id,
      {package_fk:id,patch_fk:patch.legacy_id,patch_id:patch.id});
  }
  for (let id=1;id<=2;id++) add("package",String(id),{id,name:"com.video",version:id+".0"});
  for (let index=0;index<historyCount;index++) {
    const id=index.toString(16).padStart(24,"0");
    add("history_release",id,{id,source_id:"s1",source_url:source.url,
      upstream_id:String(index),name:"Release "+index,tag:"v"+index,version:"v"+index,
      is_prerelease:index%2===1,draft:false,published_at:"2026-01-01T00:00:00Z",
      changelog:"# Original\n\n**Notes** "+index,release_notes:"notes",
      assets:[{name:"patch.rvp",size:123,browser_download_url:"https://example.test/"+index}],
      raw_metadata:{tag_name:"v"+index},availability:index===0?"unavailable":"available",
      binary_archived:false,bundle_ids:[old.bundle.id],runtimes:["revanced"],bundle_types:["ReVanced:v22"]});
  }
  const reads = [];
  const env = {...old.env,CATALOG_BACKEND:"d1",DB:db,ARCHIVE:{async get(key) {
    reads.push(key);
    const body=objects.get(key);
    return body==null?null:{size:Buffer.byteLength(body),async json(){return JSON.parse(body);}};
  }}};
  const request = async path => {
    const response=await worker.fetch(new Request("https://api.test"+path),env);
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const graph = async query => {
    const response=await worker.fetch(new Request("https://api.test/graphql",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query})
    }),env);
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  return {old,sqlite,add,env,objects,reads,queryLog,request,graph};
}

