import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import worker from "../src/index.js";
import { fixture } from "./fixture.js";
import { filterApps } from "../../shared/apps.js";
import { latestReleaseIds, matchesReleaseFilter, countLabel, patchMatchesSearch, patchDisplayName } from "../../shared/site.js";
import { renderPatchOptions } from "../../shared/detail-browser.js";
import { formatPatchDescription } from "../../shared/details.js";
import { Catalog } from "../../shared/catalog.js";

const stable = "a".repeat(24), dev = "b".repeat(24);
const info = { package_name: "com.video", app_name: "Video App",
  icon_url: "https://images.test/video.png", metadata_source: "google_play" };
const refs = [
  { bundle_id: stable, versions: ["1.0", "2.0"], unrestricted: false, patch_count: 2 },
  { bundle_id: dev, versions: ["3.0"], unrestricted: false, patch_count: 1 }
];
function appFixture() {
  return fixture({ "apps.json": [{ ...info, bundles: refs }],
    ["bundle-apps/" + stable + ".json"]: [{ ...info, ...refs[0] }],
    ["bundle-apps/" + dev + ".json"]: [{ ...info, ...refs[1] }],
    "packages.json": [{ name: "com.video", app_name: info.app_name, icon_url: info.icon_url, versions: ["1.0", "2.0"] }]
  });
}
async function call(state, path) {
  const response = await worker.fetch(new Request("https://api.test" + path), state.env);
  return { response, body: await response.json() };
}

test("App API lists names/icons and counts only matching verified relationships", async () => {
  const state = appFixture();
  let result = await call(state, "/apps?q=video%20app");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.total, 1);
  assert.equal(result.body.data[0].app_name, info.app_name);
  assert.equal(result.body.data[0].icon_url, info.icon_url);
  assert.equal(result.body.data[0].bundle_count, 1);
  assert.equal(result.body.data[0].patch_count, 2);
  assert.equal(result.body.data[0].source_count, 1);
  assert.equal(result.body.data[0].bundles, undefined);
  result = await call(state, "/api/v1/apps?include_unverified=true");
  assert.equal(result.body.data[0].bundle_count, 2);
  assert.equal(result.body.data[0].patch_count, 3);
  assert.equal((await call(state, "/apps?include_unverified=true&release=latest")).body.data[0].bundle_count, 1);
  assert.equal((await call(state, "/apps?release=prerelease")).body.total, 0);
  assert.equal((await call(state, "/apps?include_unverified=true&release=prerelease")).body.data[0].versions[0], "3.0");
  assert.equal((await call(state, "/apps?source=missing")).body.total, 0);
  assert.equal((await call(state, "/apps?bundle_type=Morphe:V1")).body.total, 0);
  assert.equal((await call(state, "/apps?app_version=1")).body.total, 0);
  assert.equal((await call(state, "/apps?app_version=1.0")).body.total, 1);
  assert.equal((await call(state, "/apps?package=com.video@3.0")).body.total, 0);
  assert.equal((await call(state, "/apps?limit=101")).response.status, 400);
  assert.equal((await call(state, "/apps?release=bad")).response.status, 400);
  assert.equal((await call(state, "/apps?sort=bad")).response.status, 400);
});

test("App details, per-bundle apps and paginated supporting releases agree", async () => {
  const state = appFixture();
  const detail = (await call(state, "/apps/com.video")).body;
  assert.equal(detail.package_name, info.package_name);
  assert.equal(detail.bundles_url, "/apps/com.video/bundles");
  const result = await call(state, "/apps/com.video/bundles?include_unverified=true&limit=1&offset=1");
  assert.equal(result.body.total, 2);
  assert.deepEqual(result.body.data[0].app_compatibility.versions, ["3.0"]);
  const perBundle = (await call(state, "/api/v1/bundles/" + stable + "/apps")).body;
  assert.equal(perBundle.data[0].app_name, info.app_name);
  assert.equal(perBundle.data[0].metadata_status, "verified");
  assert.equal((await call(state, "/bundles/" + stable + "/apps?app_version=9")).body.total, 0);
  assert.equal((await call(state, "/apps/missing")).response.status, 404);
  assert.equal((await call(state, "/bundles/" + "e".repeat(24) + "/apps")).response.status, 404);
  const patches = await call(state, "/apps/com.video/patches?app_version=1.0");
  assert.equal(patches.body.total, 1);
  assert.equal((await call(state, "/apps/com.missing/patches")).body.total, 0);
  for (const path of ["/bundles/" + stable,
    "/api/v3/bundle?source_url=https://github.com/owner/repo&version=v1"]) {
    const bundle = (await call(state, path)).body;
    assert.equal(bundle.apps[0].app_name, info.app_name);
    assert.equal(bundle.app_count, 1);
    assert.equal(bundle.apps_url, "/bundles/" + stable + "/apps");
  }
});

test("GraphQL package metadata and REST patch package metadata remain available", async () => {
  const base = fixture();
  const patches = JSON.parse(base.bodies["patches/00000.json"]);
  patches.forEach(p => p.packages.forEach(pkg => Object.assign(pkg, {app_name: info.app_name, icon_url: info.icon_url})));
  const state = fixture({ "patches/00000.json": patches,
    "packages.json": [{name:"com.video", app_name:info.app_name, icon_url:info.icon_url, versions:["1.0","2.0"]}] });
  const response = await worker.fetch(new Request("https://api.test/graphql", {
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({query:"{ package { name version app_name icon_url } }"})
  }),state.env);
  const result = await response.json();
  assert.equal(result.errors, undefined);
  assert.equal(result.data.package[0].app_name, info.app_name);
  assert.equal(result.data.package[0].icon_url, info.icon_url);
  assert.equal((await call(state, "/patches")).body.data[0].packages[0].app_name, info.app_name);
});

test("App filters merge versions and trim counts to the selected bundles", () => {
  const apps = [{ ...info, bundles: refs }];
  const bundles = [{id:stable,source_id:"s1",metadata_status:"verified"},
    {id:dev,source_id:"s1",metadata_status:"unverified"}];
  assert.equal(filterApps(apps, bundles, {q:"video app"}).length, 1);
  assert.equal(filterApps(apps, bundles, {q:"other"}).length, 0);
  assert.equal(filterApps(apps, bundles, {packageQuery:"3."})[0].patch_count, 1);
  assert.equal(filterApps(apps, bundles, {packageQuery:"com.video@1.0"})[0].bundle_count, 1);
  assert.deepEqual(filterApps(apps, [bundles[1]])[0].versions, ["3.0"]);
  assert.equal(filterApps([{...info,bundles:[{...refs[0],unrestricted:true}]}], bundles,
    {appVersion:"999",exactAppVersion:true}).length, 1);
  assert.throws(() => filterApps(apps,bundles,{q:"x".repeat(513)}),/too long/);
  assert(patchMatchesSearch({compatiblePackages:[{name:"com.video",appName:"Video App",versions:[]}]}, "video app"));
});

test("Old snapshots show unknown per-bundle versions instead of global compatibility", async () => {
  const state = fixture();
  const catalog = await new Catalog(state.env.DATA_BASE_URL, state.env.FETCH).initialize();
  const app = (await catalog.apps())[0];
  assert.deepEqual(app.bundles[0].versions, []);
  assert.equal(app.bundles[0].unrestricted, false);
  assert.equal(app.bundles[0].compatibility_unknown, true);
  assert.equal(filterApps([app], await catalog.bundles(), {appVersion:"1.0"}).length, 0);
});

test("Apps rendering includes historical matches and opens a details window", async () => {
  const source = await readFile(new URL("../../web/app.js",import.meta.url),"utf8");
  const code = source.slice(source.indexOf("function renderFilteredApps("),source.indexOf("\nfunction renderStats("));
  const nodes = [];
  const summaries = [{id:stable,source_id:"s1",source:{url:"https://github.com/owner/repo"},
    is_latest:false,is_prerelease:false,bundle_type:"ReVanced:v22",metadata_status:"verified"}];
  const latest = latestReleaseIds(summaries);
  const context = {document:{createElement:() => {
    const handlers = {};
    const node = {innerHTML:"",querySelector:() => ({addEventListener:(event,fn)=>{handlers[event]=fn;}}),handlers};
    nodes.push(node);return node;
  }, scrollingElement:{}},summaries,applications:[{...info,bundles:[refs[0]]}],filterApps,
    currentSourceUrl:"",currentBundleType:"",currentFilter:"all",currentSearchQuery:"",
    currentPackageFilter:"",matchesReleaseFilter,countLabel,
    transformBundle:b=>({...b,isLatest:latest.has(b.id),isPrerelease:b.is_prerelease}),
    filteredBundles:[],clearVirtualizer(){},setupVirtualizer(){},updateStatus(){},
    status:{},escapeHtml:String,installAvatarFallback(){},input:{},packageFilter:{},
    detailsBrowser:{activateCard(card,fn){card.openDetails=fn;},openApp(app){context.openedApp=app;}},
    selectTab:tab=>{context.selectedTab=tab;},renderFilteredBundles(){}};
  runInNewContext(code,context);
  context.renderFilteredApps(false);
  assert.equal(context.filteredBundles.length, 1);
  context.renderApp(context.filteredBundles[0],{appendChild(){}});
  assert.match(nodes[0].innerHTML,/Video App/);
  assert.match(nodes[0].innerHTML,/com.video/);
  assert.match(nodes[0].innerHTML,/images.test/);
  nodes[0].openDetails();
  assert.equal(context.openedApp.package_name,"com.video");
  assert.doesNotMatch(nodes[0].innerHTML,/View compatible bundles/);
});

test("Bundle patch package labels show names and packages without app images", async () => {
  const source = await readFile(new URL("../../web/app.js",import.meta.url),"utf8");
  const code = source.slice(source.indexOf("function renderPatch("),source.indexOf("\nfunction sourceName("));
  const context = { escapeHtml: value => String(value ?? ""), renderPatchOptions, patchDisplayName, formatPatchDescription };
  runInNewContext(code, context);
  const html = context.renderPatch({name:"Hide ads",
    description:"\n    Set up the patch.\n\n    - Open settings\n    - Save\n",
    compatiblePackages:[{name:"com.video",appName:"Video App",versions:["1.0","2.0"]},
      {name:"org.example.other",versions:[]}]});
  assert.match(html,/<span class="patch-description">Set up the patch\.\n\n- Open settings\n- Save<\/span>/);
  assert.match(html,/Video App/);
  assert.match(html,/<span class="package-id">com\.<wbr>video<\/span>/);
  assert.match(html,/<span class="package-name">org\.<wbr>example\.<wbr>other<\/span>/);
  assert.deepEqual([...html.matchAll(/role="listitem">([^<]+)/g)].map(version => version[1]), ["1.0","2.0"]);
  assert.match(html,/<span class="package-version">All versions<\/span>/);
  assert.doesNotMatch(html,/<img/);
  const internal = context.renderPatch({name:"  ",display_name:"Enable Android Debugging Patch",hidden:true});
  assert.match(internal,/Enable Android Debugging Patch/);
  assert.match(internal,/Internal patch/);
});

test("Apps tab hides irrelevant controls and supports keyboard navigation", async () => {
  const source = await readFile(new URL("../../web/app.js",import.meta.url),"utf8");
  const code = source.slice(source.indexOf("const catalogTabs = "),source.indexOf("\nvoid loadBundles();"));
  function node(id) {
    return {id,hidden:false,attrs:{},handlers:{},tabIndex:0,classList:{toggle(){}},
      setAttribute(key,value){this.attrs[key]=value;},
      addEventListener(event,fn){this.handlers[event]=fn;},
      click(){this.handlers.click();},focus(){this.focused=true;}};
  }
  const tabs = [node("bundles-tab"),node("apps-tab"),node("changelogs-tab")], fields = {};
  const context = {document:{querySelectorAll:()=>tabs,querySelector:()=>node("row"),
    getElementById:id=>fields[id]??=node(id)}, results:node("results"),
    input:node("search"), viewToggle:node("view-toggle"), calendarToggle:node("calendar-toggle"), packageFilter:node("package-filter"),
    track:node("v-track"), releaseFeed:{...node("release-feed"),replaceChildren(){}},
    currentTab:"bundles", currentSourceUrl:"", catalog:null,
    browsePreferences:{activate(){},read(){return {source:""};}}, saveBrowsePreferences(){}, restoreBrowsePreferences(){},
    detailsBrowser:{close(){}},writeNavigation(){},
    resetBundleSelection(){},clearVirtualizer(){},renderFilteredBundles(){}};
  runInNewContext(code,context);
  tabs[1].click();
  assert.equal(context.currentTab,"apps");
  assert.equal(context.calendarToggle.hidden,true);
  assert.equal(fields["bundle-version-field"].hidden,true);
  assert.equal(context.input.attrs["aria-label"],"Search apps");
  assert.equal(tabs[1].attrs["aria-selected"],"true");
  tabs[1].handlers.keydown({key:"ArrowLeft",preventDefault(){}});
  assert.equal(context.currentTab,"bundles");
  assert.equal(fields["bundle-version-field"].hidden,false);
  assert.equal(tabs[0].focused,true);
  tabs[0].handlers.keydown({key:"ArrowLeft",preventDefault(){}});
  assert.equal(context.currentTab,"changelogs");
  assert.equal(context.packageFilter.hidden,true);
  assert.equal(context.releaseFeed.hidden,false);
  assert.equal(context.calendarToggle.hidden,false);
  assert.equal(tabs[2].focused,true);
});

test("App routes exclude disabled sources and paginate large bundle app lists", async () => {
  const base = fixture();
  const apps = Array.from({length:101}, (_, index) => ({
    ...info, package_name:"com.app" + index, ...refs[0]
  }));
  const state = fixture({
    ["bundle-apps/" + stable + ".json"]:apps,
    "apps.json":apps.map(app => ({...app,bundles:[refs[0]]}))
  });
  const imported = await call(state,"/api/v3/bundle?source_url=https://github.com/owner/repo&version=v1");
  assert.equal(imported.body.apps.length,100);
  assert.equal(imported.body.app_count,101);
  const remaining = await call(state,imported.body.apps_url + "?limit=100&offset=100");
  assert.equal(remaining.body.total,101);
  assert.equal(remaining.body.data.length,1);
  const source = JSON.parse(base.bodies["sources.json"])[0];
  const disabled = fixture({"sources.json":[{...source,enabled:false}],
    "apps.json":[{...info,bundles:refs}]});
  assert.equal((await call(disabled,"/apps?include_unverified=true")).body.total,0);
  assert.equal((await call(disabled,"/bundles/" + stable + "/apps")).response.status,404);
});


test("App lookups avoid release indexes larger than the Worker read budget", async () => {
  const base = appFixture();
  const releases = JSON.parse(base.bodies["bundles.json"]);
  const fields = ["id", "source_id", "version", "bundle_type", "ecosystem", "created_at",
    "is_latest", "is_prerelease", "channels", "metadata_status", "patch_count", "packages"];
  const state = fixture({
    ...Object.fromEntries(Object.entries(base.bodies).map(([key, value]) => [key, JSON.parse(value)])),
    "bundles.json": releases.map(row => ({...row, description:"x".repeat(7 * 1024 * 1024)})),
    "app-bundles.json": releases.map(row => Object.fromEntries(fields.map(key => [key, row[key]])))
  });
  for (const path of ["/apps", "/apps/com.video", "/apps/com.video/bundles",
    "/apps/com.video/patches", "/bundles/" + stable + "/apps", "/bundles/" + stable]) {
    const result = await call(state, path);
    assert.equal(result.response.status, 200, path + ": " + JSON.stringify(result.body));
    if (path === "/apps/com.video/bundles")
      assert.equal(result.body.data[0].description, base.bundle.description);
    if (path === "/apps/com.video/patches")
      assert.equal(result.body.data[0].bundle.description, base.bundle.description);
  }
  assert(!state.requests.some(url => url.endsWith("/bundles.json")));
});




test("App browsing excludes legacy human labels that cannot identify an Android app", () => {
  const bundles = [{id:stable,source_id:"s1",metadata_status:"verified"}];
  const apps = ["#Notepad","1Weather","Adobe Lightroom","com.video"].map(package_name =>
    ({...info,package_name,bundles:[refs[0]]}));
  assert.deepEqual(filterApps(apps,bundles).map(app=>app.package_name),["com.video"]);
});


test("Patch display preserves options and distinguishes universal from empty restrictions", async () => {
  const source = await readFile(new URL("../../web/app.js",import.meta.url),"utf8");
  const code = source.slice(source.indexOf("function transformPatch("),source.indexOf("\nasync function bundlePatches("));
  const context = {};
  runInNewContext(code,context);
  const options = [{key:"enabled",default:false}];
  assert.equal(context.transformPatch({packages:[],compatiblePackages:null,options}).universal,true);
  assert.equal(context.transformPatch({packages:[],compatiblePackages:{"com.video":[]},options}).universal,false);
  const patch = context.transformPatch({packages:[{name:"com.video",versions:[]}],options});
  assert.equal(patch.universal,false);
  assert.equal(patch.options,options);
});
