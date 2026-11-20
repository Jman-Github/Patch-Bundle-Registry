import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createBrowsePreferences } from "../../shared/preferences.js";
import { countLabel, matchesReleaseFilter } from "../../shared/site.js";
import { compareReleaseDates } from "../../shared/catalog.js";

function storage() {
    let value;
    return { getItem: () => value, setItem: (key, next) => { value = next; } };
}
test("Browsing preferences survive reload with independent tab searches and filters", () => {
    const saved = storage(), prefs = createBrowsePreferences(() => saved);
    prefs.save("bundles", {search:"Hide Ads", package:"com.video@19.16", source:"https://github.com/a/b",
        version:"v1", type:"Morphe:V1", release:"all", grid:false});
    prefs.activate("apps");
    prefs.save("apps", {search:"Video App", package:"20.0", type:"Reseam", release:"latest", grid:true, version:"ignored"});
    const reload = createBrowsePreferences(() => saved);
    assert.equal(reload.activeTab, "apps");
    assert.equal(reload.read("bundles").search, "Hide Ads");
    assert.equal(reload.read("bundles").version, "v1");
    assert.equal(reload.read("apps").search, "Video App");
    assert.equal(reload.read("apps").version, "");
    assert.equal(reload.read("apps").release, "latest");
    reload.read("bundles").search = "mutated";
    assert.equal(reload.read("bundles").search, "Hide Ads");
});
test("Malformed or blocked storage preserves usable defaults and in-memory tab state", () => {
    for (const getStorage of [() => ({getItem: () => "{"}),
        () => { throw new Error("Blocked"); },
        () => ({getItem: () => null, setItem: () => { throw new Error("Full"); }})]) {
        const prefs = createBrowsePreferences(getStorage, false);
        assert.equal(prefs.read("apps").grid, false);
        prefs.save("bundles", {search:"ads", release:"invalid"});
        prefs.activate("apps");
        assert.equal(prefs.read("bundles").search, "ads");
        assert.equal(prefs.read("bundles").release, "latest");
    }
});
test("Count labels use singular for one and plural for zero or many", () => {
    for (const [noun, plural] of [["bundle","bundles"], ["app group","app groups"],
        ["source","sources"], ["patch","patches"]]) {
        assert.equal(countLabel(0, noun, plural), "0 " + plural);
        assert.equal(countLabel(1, noun, plural), "1 " + noun);
        assert.equal(countLabel(2, noun, plural), "2 " + plural);
    }
});
function node(id = "") {
    const classes = new Set();
    return {id, value:"", options:[], dataset:{}, handlers:{},
        classList:{contains: x => classes.has(x), toggle(x, enabled) {
            if (enabled) classes.add(x); else classes.delete(x);
        }},
        setAttribute(){}, replaceChildren(...options) { this.options = options; },
        addEventListener(event, fn) { this.handlers[event] = fn; },
        click() { this.handlers.click(); }, focus() {}
    };
}
async function frontend(prefs, suppliedSummaries) {
    const source = await readFile(new URL("../../web/app.js", import.meta.url), "utf8");
    const tabs = [node("bundles-tab"),node("apps-tab")], fields = {};
    const url = "https://github.com/a/b";
    const summaries = suppliedSummaries || [
        {id:"new", version:"v2", source:{url}, bundle_type:"Morphe:V1", is_latest:true},
        {id:"old", version:"v1", source:{url}, bundle_type:"Morphe:V1", is_latest:false}
    ];
    const transformBundle = b => ({...b, sourceUrl:b.source.url,
        bundleType:b.bundle_type, isLatest:b.is_latest, isPrerelease:Boolean(b.is_prerelease)});
    const context = {document:{querySelectorAll:()=>tabs,querySelector:()=>node(),
        getElementById:id=>fields[id]??=node(id)},results:node(),container:node(),viewToggle:node(),
        input:node(),packageFilter:node(),sourceFilter:node(),bundleVersionFilter:node(),bundleTypeFilter:node(),status:node(),
        filterButtons:["all","latest","release","prerelease"].map(filter=>Object.assign(node(),{dataset:{filter}})),
        navigationReady:true,navigationRevision:0,navigation:{read:()=>null,write(){return true;}},
        detailsBrowser:{close(){},openApp(){},async openBundle(){}},
        sourceSelection:0,sourcePicker:{sync(){}}, browsePreferences:prefs,currentTab:prefs.activeTab,
        summaries,latestBundles:[transformBundle(summaries[0])],sourceVersions:[],allBundles:[],catalog:{},
        transformBundle,compareReleaseDates,matchesReleaseFilter,bundleTypeLabel:x=>x,
        Option: function(label,value) { this.label=label; this.value=value; },
        clearVirtualizer(){},renderFilteredBundles(options={}){context.saveBrowsePreferences({updateUrl:options.updateUrl !== false,userAction:options.userAction === true});}};
    runInNewContext(source.slice(source.indexOf("async function selectSource("),
        source.indexOf("\nfunction transformPatch(")), context);
    // Exercise the production selection/reconciliation functions, not a parallel implementation.
    runInNewContext(source.slice(source.indexOf("function reconcileSourceSelection("),
        source.indexOf("\nfunction installAvatarFallback(")), context);
    runInNewContext(source.slice(source.indexOf("function saveBrowsePreferences("),
        source.indexOf("\nvoid loadBundles();")), context);
    return {context,tabs};
}
test("Switching tabs restores controls and a selected historical release", async () => {
    const prefs = createBrowsePreferences(() => storage());
    prefs.save("bundles", {search:"Bundle Search",package:"com.video",source:"https://github.com/a/b",
        version:"v1",type:"Morphe:V1",release:"all",grid:false});
    const {context:c,tabs} = await frontend(prefs);
    assert.equal(c.input.value,"Bundle Search");
    assert.equal(c.currentBundleVersion,"v1");
    assert.equal(c.allBundles[0].id,"old");
    tabs[1].click();
    assert.equal(c.input.value,"");
    assert.equal(c.currentSourceUrl,"");
    assert.equal(c.currentBundleVersion,"");
    c.input.value="Video App";
    c.packageFilter.value="19.16";
    c.currentFilter="latest";
    tabs[0].click();
    assert.equal(c.input.value,"Bundle Search");
    assert.equal(c.packageFilter.value,"com.video");
    assert.equal(c.currentBundleVersion,"v1");
    assert.equal(c.allBundles[0].id,"old");
    tabs[1].click();
    assert.equal(c.input.value,"Video App");
    assert.equal(c.packageFilter.value,"19.16");
    assert.equal(c.currentFilter,"latest");
});
test("Removed sources, versions and bundle types do not restore hidden active filters", async () => {
    const prefs = createBrowsePreferences(() => storage());
    prefs.save("bundles", {source:"https://github.com/deleted/repo",version:"v0",type:"Removed",release:"all"});
    const {context:c} = await frontend(prefs);
    assert.equal(c.currentSourceUrl,"");
    assert.equal(c.currentBundleVersion,"");
    assert.equal(c.currentBundleType,"");
    assert.equal(c.bundleVersionFilter.disabled,true);
    assert.equal(c.allBundles[0].id,"new");
});


test("Switching sources rebuilds versions after clearing a retired bundle type", async () => {
    const url = "https://github.com/a/b", other = "https://github.com/c/d";
    const prefs = createBrowsePreferences(() => storage());
    prefs.save("bundles", {source:url,type:"ReVanced:v21",release:"all",version:"v1"});
    const {context:c} = await frontend(prefs, [
        {id:"new",version:"v2",source:{url},bundle_type:"Morphe:V1",is_latest:true},
        {id:"old",version:"v1",source:{url},bundle_type:"ReVanced:v21",is_latest:false},
        {id:"other",version:"v3",source:{url:other},bundle_type:"Morphe:V1",is_latest:true}
    ]);
    assert.equal(c.currentBundleType,"ReVanced:v21");
    await c.selectSource(other);
    assert.equal(c.currentBundleType,"");
    assert.equal(c.currentBundleVersion,"");
    assert(c.bundleVersionFilter.options.some(option => option.value === "v3"));
    assert.equal(prefs.read("bundles").source,other);
});

test("Historical versions are selectable before loading changelogs", async () => {
    const prefs = createBrowsePreferences(() => storage());
    prefs.save("bundles", { source: "https://github.com/a/b", release: "all" });
    const { context: c, tabs } = await frontend(prefs);
    c.catalog = { async historyBundles() { return []; }, file() { assert.fail("Unexpected detail request"); } };
    await c.selectBundleVersion("v1");
    assert.equal(c.allBundles[0].id, "old");
    assert.equal(prefs.read("bundles").version, "v1");
    tabs[1].click();
    assert.equal(c.currentBundleVersion, "");
    tabs[0].click();
    assert.equal(c.currentBundleVersion, "v1");
    await c.selectSource("");
    assert.equal(c.currentBundleVersion, "");
});


test("A pending source history cannot clear a version restored by tab navigation",async()=>{
    const prefs=createBrowsePreferences(()=>storage());
    const url="https://github.com/a/b";
    prefs.save("bundles",{source:url,release:"all"});
    const {context:c,tabs}=await frontend(prefs);
    let resolve;
    c.catalog={historyBundles:()=>new Promise(done=>{resolve=done;})};
    const pending=c.selectSource(url);
    tabs[1].click();
    prefs.save("bundles",{source:url,version:"v1",release:"all"});
    tabs[0].click();
    assert.equal(c.currentBundleVersion,"v1");
    resolve([]);
    await pending;
    assert.equal(c.currentBundleVersion,"v1");
    assert.equal(prefs.read("bundles").version,"v1");
});

test("Failed source history keeps the latest source release selectable", async () => {
    const { context: c } = await frontend(createBrowsePreferences(() => storage()));
    c.recoverGeneration = async () => false;
    c.catalog = { async historyBundles() { throw new Error("Offline"); } };
    await c.selectSource("https://github.com/a/b");
    assert.equal(c.currentSourceUrl, "https://github.com/a/b");
    assert.equal(c.bundleVersionFilter.disabled, false);
    assert(c.bundleVersionFilter.options.some(option => option.value === "v2"));
    assert.match(c.status.textContent, /Older versions could not be loaded/);
});

test("A source error awaiting generation recovery cannot overwrite a newer view",async()=>{
    const prefs=createBrowsePreferences(()=>storage());
    const url="https://github.com/a/b";
    prefs.save("bundles",{source:url,release:"all"});
    const {context:c}=await frontend(prefs);
    let finishRecovery,started;
    const recovering=new Promise(done=>{started=done;});
    c.status={textContent:"Current view"};
    c.recoverGeneration=()=>{started();return new Promise(done=>{finishRecovery=done;});};
    c.catalog={historyBundles:async()=>{throw new Error("Old request failed");}};
    const pending=c.selectSource(url);
    await recovering;
    await c.selectSource("");
    c.status.textContent = "Current view";
    finishRecovery(false);
    await pending;
    assert.equal(c.status.textContent,"Current view");
});

test("A shared source link shows known releases when its history is unavailable", async () => {
    const { context: c } = await frontend(createBrowsePreferences(() => storage()));
    const url = "https://github.com/a/b";
    c.catalog = { async historyBundles() { throw new Error("History unavailable"); } };
    c.recoverGeneration = async () => false;
    await c.restoreNavigation({ tab: "bundles", browse: { source: url, version: "v1", release: "all" } });
    assert.equal(c.currentSourceUrl, url);
    assert.equal(c.currentBundleVersion, "v1");
    assert.match(c.status.textContent, /Older versions could not be loaded/);
});

test("A shared historical bundle loads source history before opening the selected section", async () => {
    const {context:c} = await frontend(createBrowsePreferences(() => storage()));
    const url="https://github.com/a/b", opened=[], requested=[];
    c.catalog={async historyBundles(source) {
        requested.push(source);
        return [{id:"history",version:"v0",source:{url},bundle_type:"Morphe:V1",is_latest:false}];
    }};
    c.detailsBrowser.openBundle=async (bundle,options)=>opened.push({bundle,options});
    await c.restoreNavigation({tab:"bundles",browse:{release:"latest"},
        detail:{kind:"bundle",id:"history",source:url,version:"v0",section:"changelog"}});
    assert.deepEqual(requested,[url]);
    assert.equal(opened.length,1);
    assert.equal(opened[0].bundle.version,"v0");
    assert.equal(opened[0].options.section,"changelog");
    assert.equal(opened[0].options.notify,false);
});

test("A slow shared-link request cannot reopen details after the user changes tabs", async () => {
    const {context:c,tabs} = await frontend(createBrowsePreferences(() => storage()));
    let resolve;
    const waiting=new Promise(done=>resolve=done), opened=[];
    c.catalog={historyBundles:()=>waiting};
    c.detailsBrowser.openBundle=async bundle=>opened.push(bundle);
    const pending=c.restoreNavigation({tab:"bundles",browse:{release:"latest"},
        detail:{kind:"bundle",id:"old",source:"https://github.com/a/b",version:"v1",section:"patches"}});
    tabs[1].click();
    resolve([]);
    await pending;
    assert.equal(c.currentTab,"apps");
    assert.equal(opened.length,0);
});

test("Shared links cannot bypass disabled sources in a static catalog", async () => {
    const {context:c} = await frontend(createBrowsePreferences(() => storage()));
    let filesRead = 0;
    c.catalog={async file(){filesRead++;return {id:"disabled"};}};
    c.status={textContent:""};
    c.recoverGeneration=async()=>false;
    await c.restoreNavigation({tab:"bundles",browse:{},detail:{
        kind:"bundle",id:"disabled",section:"patches"
    }});
    assert.equal(filesRead,0);
    assert.match(c.status.textContent,/no longer in the catalog/);
});

test("Shared details finish opening after a catalog generation recovery", async () => {
    const {context:c} = await frontend(createBrowsePreferences(() => storage()));
    const opened=[],url="https://github.com/a/b";
    let attempts=0;
    c.catalog={async historyBundles() {
        if (++attempts===1) throw Object.assign(new Error("Catalog changed"),{generationUnavailable:true});
        return [];
    }};
    c.recoverGeneration=async()=>{c.saveBrowsePreferences();return true;};
    c.detailsBrowser.openBundle=async bundle=>opened.push(bundle);
    await c.restoreNavigation({tab:"bundles",browse:{},detail:{
        kind:"bundle",id:"old",source:url,version:"v1",section:"patches"
    }});
    assert.equal(attempts,2);
    assert.equal(opened.length,1);
    assert.equal(opened[0].bundleType,"Morphe:V1");
});

test("Tab selection during catalog startup replaces a pending shared detail", async () => {
    const {context:c,tabs} = await frontend(createBrowsePreferences(() => storage()));
    c.navigationReady=false;
    let route={tab:"bundles",browse:{},detail:{kind:"bundle",id:"old"}};
    c.navigation={read:()=>route,write:next=>{route=next;}};
    tabs[1].click();
    assert.equal(route.tab,"apps");
    assert.equal(route.detail,null);
});

test("Unchanged URL writes do not cancel a shared link while history is loading", async () => {
    const {context:c} = await frontend(createBrowsePreferences(() => storage()));
    let resolve;
    const waiting=new Promise(done=>resolve=done),opened=[];
    c.catalog={historyBundles:()=>waiting};
    c.navigation.write=()=>false;
    c.detailsBrowser.openBundle=async bundle=>opened.push(bundle);
    const pending=c.restoreNavigation({tab:"bundles",browse:{},detail:{
        kind:"bundle",id:"old",source:"https://github.com/a/b",version:"v1",section:"patches"
    }});
    c.saveBrowsePreferences();
    resolve([]);
    await pending;
    assert.equal(opened.length,1);
});

test("Typing during catalog startup cancels the pending detail and shares the new filter", async () => {
    const {context:c} = await frontend(createBrowsePreferences(() => storage()));
    c.navigationReady=false;
    c.renderAfterInput=()=>{};
    let route={tab:"bundles",browse:{},detail:{kind:"bundle",id:"old"}};
    c.navigation={read:()=>route,write:next=>{route=next;return true;}};
    const source=await readFile(new URL("../../web/app.js",import.meta.url),"utf8");
    runInNewContext(source.slice(source.indexOf('input.addEventListener("input"'),
        source.indexOf('\npackageFilter.addEventListener("input"')),c);
    c.input.value="New search";
    c.input.handlers.input();
    assert.equal(route.detail,null);
    assert.equal(route.browse.search,"New search");
});

test("Catalog recovery may canonicalize a shared URL without dropping its detail", async () => {
    const {context:c} = await frontend(createBrowsePreferences(() => storage()));
    const opened=[],url="https://github.com/a/b";
    let attempts=0;
    let route={tab:"bundles",browse:{},detail:{
        kind:"bundle",id:"old",source:url,version:"v1",section:"patches"
    }};
    c.navigation={read:()=>route,write:next=>{route=next;return true;}};
    c.catalog={async historyBundles() {
        if (++attempts===1) throw Object.assign(new Error("Catalog changed"),{generationUnavailable:true});
        return [];
    }};
    // The recovered catalog renders and fills in default URL filters/layout.
    c.recoverGeneration=async()=>{c.saveBrowsePreferences();return true;};
    c.detailsBrowser.openBundle=async bundle=>opened.push(bundle);
    await c.restoreNavigation(route);
    assert.equal(attempts,2);
    assert.equal(opened.length,1);
});

test("User navigation during catalog recovery cancels the earlier shared detail", async () => {
    const {context:c,tabs} = await frontend(createBrowsePreferences(() => storage()));
    const opened=[];
    let recovering,finishRecovery;
    const started=new Promise(resolve=>recovering=resolve);
    c.catalog={async historyBundles() {throw new Error("Catalog changed");}};
    c.recoverGeneration=()=>{recovering();return new Promise(resolve=>finishRecovery=resolve);};
    c.detailsBrowser.openBundle=async bundle=>opened.push(bundle);
    const pending=c.restoreNavigation({tab:"bundles",browse:{},detail:{
        kind:"bundle",id:"old",source:"https://github.com/a/b",version:"v1",section:"patches"
    }});
    await started;
    tabs[1].click();
    finishRecovery(true);
    await pending;
    assert.equal(c.currentTab,"apps");
    assert.equal(opened.length,0);
});
