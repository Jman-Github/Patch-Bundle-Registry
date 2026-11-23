import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import worker from "../src/index.js";
import {d1Fixture} from "./d1-fixture.js";

test("public GraphQL POST reuses only the same body, origin and active generation", async () => {
  const fixture = d1Fixture();
  const original = globalThis.caches, stored = new Map(), pending = [];
  globalThis.caches = {default: {
    async match(key) { return stored.get(key.url)?.clone(); },
    async put(key, response) {
      assert.equal(key.method, "GET");
      stored.set(key.url, response.clone());
    }
  }};
  const context = {waitUntil: promise => pending.push(promise)};
  const origin = fixture.env.CORS_ORIGINS;
  const query = "query Lookup($n:Int!){bundle(limit:$n){id}}";
  const post = (payload, headers = {}) => worker.fetch(new Request("https://api.test/graphql", {
    method: "POST", body: JSON.stringify(payload),
    headers: {"Content-Type": "application/json", Origin: origin, ...headers}
  }), fixture.env, context);
  const payload = {query, variables: {n: 1}};
  try {
    const cold = await post(payload);
    const body = await cold.text();
    const generation = fixture.old.manifest.generation;
    assert.equal(cold.status, 200, body);
    assert.equal(JSON.parse(body).data.bundle.length, 1);
    const expectedTag = '"' + createHash("sha256").update(generation + body).digest("hex") + '"';
    assert.equal(cold.headers.get("ETag"), expectedTag);
    await Promise.all(pending);
    assert.equal(stored.size, 1);

    const before = fixture.queryLog.length;
    const warm = await post(payload, {"If-None-Match": expectedTag});
    assert.equal(warm.status, 200);
    assert.equal(await warm.text(), body);
    assert.equal(warm.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(fixture.queryLog.length, before + 1);

    const entry = new URL([...stored.keys()][0]);
    const get = await worker.fetch(new Request(entry, {headers: {Origin: origin}}), fixture.env, context);
    assert.ok(get.status >= 400, "a GET must not retrieve a POST cache entry");

    const varied = await post({query, variables: {n: 2}}, {Origin: "https://other.test"});
    assert.equal(varied.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal((await varied.json()).data.bundle.length, 2);
    const privateRequest = await post(payload, {Authorization: "Bearer test"});
    assert.equal(privateRequest.headers.get("Cache-Control"), "no-store");
    const credentialCookie = await post(payload, {Cookie: "session=test"});
    assert.equal(credentialCookie.headers.get("Cache-Control"), "no-store");

    const error = await post({query, variables: {n: "invalid"}});
    assert.ok((await error.json()).errors);
    await Promise.all(pending);
    const beforeLive = stored.size;
    const live = await post({query: "{...Jobs} fragment Jobs on query_root { jobs: refresh_jobs { status } }"});
    assert.equal(live.headers.get("Cache-Control"), "no-store");
    assert.ok(Array.isArray((await live.json()).data.jobs));
    await Promise.all(pending);
    assert.equal(stored.size, beforeLive);

    const next = "e".repeat(24);
    const document = JSON.parse(fixture.objects.get("generations/test.json"));
    document.manifest.generation = next;
    fixture.objects.set("generations/next.json", JSON.stringify(document));
    fixture.sqlite.prepare("INSERT INTO catalog_generations VALUES(2,?,'generations/next.json','ready','now')").run(next);
    fixture.sqlite.exec("UPDATE catalog_state SET active_seq=2");
    const rotated = await post(payload);
    assert.equal(rotated.status, 200);
    assert.equal(rotated.headers.get("X-Catalog-Generation"), next);
    assert.notEqual(rotated.headers.get("ETag"), expectedTag);
    await Promise.all(pending);
  } finally { globalThis.caches = original; fixture.sqlite.close(); }
});
