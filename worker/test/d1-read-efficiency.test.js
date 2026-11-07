import test from "node:test";
import assert from "node:assert/strict";
import {d1Fixture} from "./d1-fixture.js";

function template(f, kind) {
  return JSON.parse(f.sqlite.prepare("SELECT data FROM catalog_records WHERE kind=? LIMIT 1").get(kind).data);
}

// Each bundle belongs to its own source so per-row hydration would be visible.
function fanout(f, count) {
  const source = template(f, "source"), bundle = template(f, "bundle");
  f.sqlite.exec("DELETE FROM catalog_records WHERE kind IN ('source','source_metadata','bundle','patch','patch_package')");
  const bundles = [];
  for (let i = 0; i < count; i++) {
    const sourceId = "s" + i, bundleId = i.toString(16).padStart(24, "0");
    f.add("source", sourceId, {...source, id: i + 1, catalog_id: sourceId,
      url: "https://github.com/owner/repo" + i, enabled: true, availability: "available",
      source_metadatum: {...source.source_metadatum,
        owner_avatar_url: "https://example.test/avatar" + i + ".png"}});
    f.add("bundle", bundleId, {...bundle, id: i + 1, catalog_id: bundleId, source_fk: i + 1,
      source_id: sourceId, version: "v" + i, is_latest: true, metadata_status: "verified",
      availability: "available", channels: ["latest"]});
    bundles.push(bundleId);
  }
  return bundles;
}

async function queriesFor(f, path) {
  const before = f.queryLog.length;
  const result = await f.request(path);
  return {result, queries: f.queryLog.length - before};
}

test("D1 collection hydration batches source rows instead of querying each bundle", async () => {
  const f = d1Fixture();
  try {
    fanout(f, 60);
    const {result, queries} = await queriesFor(f, "/bundles?limit=60");
    assert.equal(result.data.length, 60);
    assert.ok(result.data.every(row => row.source?.url));
    assert.ok(queries <= 8, "expected batched hydration, used " + queries + " queries");
  } finally { f.sqlite.close(); }
});

test("D1 patch pages batch bundle and source hydration", async () => {
  const f = d1Fixture();
  try {
    const bundles = fanout(f, 40);
    const base = JSON.parse(f.old.bodies["patches/00000.json"])[0];
    for (let i = 0; i < 40; i++) {
      const id = "0".repeat(20) + i.toString(16).padStart(4, "0");
      f.add("patch", id, {...base, id: i + 1, catalog_id: id, bundle_fk: i + 1,
        bundle_id: bundles[i], name: "Patch " + i, description: "Patch " + i,
        metadata_status: "verified", hidden: false, loader_excluded: false,
        packages: [{name: "com.video", versions: ["1.0"]}]});
    }
    const {result, queries} = await queriesFor(f, "/patches?include_unverified=true&limit=40");
    assert.equal(result.data.length, 40);
    assert.ok(result.data.every(row => row.bundle?.source?.url));
    assert.ok(queries <= 9, "expected batched hydration, used " + queries + " queries");
  } finally { f.sqlite.close(); }
});

test("GraphQL singular relationships share one batch per request", async () => {
  const f = d1Fixture();
  try {
    fanout(f, 60);
    const before = f.queryLog.length;
    const graph = await f.graph("{bundle(limit:100){id icon_url owner_avatar_url source{id url}}}");
    const queries = f.queryLog.length - before;
    assert.equal(graph.data.bundle.length, 60);
    assert.deepEqual(new Set(graph.data.bundle.map(row => row.source?.id)),
      new Set(Array.from({length: 60}, (_, i) => i + 1)));
    for (const row of graph.data.bundle)
      assert.equal(row.icon_url, "https://example.test/avatar" + (row.id - 1) + ".png");
    assert.ok(queries <= 5, "expected one relationship batch, used " + queries + " queries");
  } finally { f.sqlite.close(); }
});

test("D1 imports reuse complete bundle rows without R2 detail reads", async () => {
  const f = d1Fixture();
  try {
    for (const path of ["/api/v3/bundle?source_url=https://github.com/owner/repo&version=v1",
      "/api/v1/bundle/1", "/api/v1/bundle/owner/repo/v1"]) await f.request(path);
    assert.ok(f.reads.every(key => key === "generations/test.json"), JSON.stringify(f.reads));
  } finally { f.sqlite.close(); }
});

test("D1 app bundle pages batch bundle and source hydration", async () => {
  const f = d1Fixture();
  try {
    const bundles = fanout(f, 40);
    f.add("app", "com.fanout", {package_name: "com.fanout", app_name: "Fanout",
      icon_url: null, metadata_source: null, bundles: bundles.map(bundleId => ({
        bundle_id: bundleId, patch_count: 1, versions: ["1.0"], unrestricted: false
      }))});
    const {result, queries} = await queriesFor(f,
      "/apps/com.fanout/bundles?include_unverified=true&limit=40");
    assert.equal(result.data.length, 40);
    assert.ok(result.data.every(row => row.source?.url && row.app_compatibility));
    assert.ok(queries <= 9, "expected batched hydration, used " + queries + " queries");
  } finally { f.sqlite.close(); }
});
