import assert from "node:assert/strict";
import test from "node:test";
import { matchingOptions } from "../../shared/source-picker.js";
import { bindActions, iconAction, importFormatAction } from "../../shared/actions.js";
import { createBrowsePreferences } from "../../shared/preferences.js";

test("Source search matches multiple terms across repository labels and hosts", () => {
    const options = [{label:"All sources", value:""},
        {label:"Team / Video",value:"https://github.com/team/video"},
        {label:"Team / Music",value:"https://git.example/team/music"}];
    assert.equal(matchingOptions(options, "").length, 3);
    assert.deepEqual(matchingOptions(options, " TEAM github "), [options[1]]);
    assert.deepEqual(matchingOptions(options, "music git.example"), [options[2]]);
    assert.deepEqual(matchingOptions(options, "missing"), []);
});

test("New tabs default to Latest while explicit selections and legacy types survive", () => {
    const prefs = createBrowsePreferences(() => ({getItem:()=>JSON.stringify({
        tabs:{bundles:{release:"release",type:"ReSeam"},apps:{search:"music"}}
    })}));
    assert.equal(prefs.read("bundles").release,"release");
    assert.equal(prefs.read("bundles").type,"Reseam");
    assert.equal(prefs.read("apps").release,"latest");
    assert.equal(prefs.read("apps").search,"music");
});

test("Touch holds show labels without performing an action, and normal taps copy", async t => {
    t.mock.timers.enable({apis:["setTimeout"]});
    const classes = new Set(), attributes = new Map([["aria-label", "Copy package name"]]), tip = {};
    const action = Object.assign(new EventTarget(), {
        dataset:{copyText:"com.example.video",tooltip:"Copy package name"},
        classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)},
        hasAttribute:name=>name==="data-copy-text",
        setAttribute:(key,value)=>attributes.set(key,value),
        querySelector:()=>tip
    });
    const previous = Object.getOwnPropertyDescriptor(globalThis,"navigator");
    const copied = [];
    Object.defineProperty(globalThis,"navigator",{configurable:true,value:{
        clipboard:{writeText:async value=>copied.push(value)}
    }});
    t.after(()=>{
        if(previous) Object.defineProperty(globalThis,"navigator",previous);
        else delete globalThis.navigator;
    });
    bindActions({querySelectorAll:()=>[action]});
    action.dispatchEvent(Object.assign(new Event("pointerdown"),{pointerType:"touch"}));
    t.mock.timers.tick(500);
    assert(classes.has("tooltip-visible"));
    action.dispatchEvent(new Event("pointerup"));
    const heldClick = new Event("click",{cancelable:true});
    action.dispatchEvent(heldClick);
    assert(heldClick.defaultPrevented);
    assert.deepEqual(copied,[]);
    t.mock.timers.tick(1800);
    action.dispatchEvent(new Event("click",{cancelable:true}));
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(copied,["com.example.video"]);
    assert.equal(tip.textContent,"Copied!");
    assert.equal(attributes.get("aria-label"),"Copy package name");
    t.mock.timers.tick(1800);
    assert.equal(attributes.get("aria-label"),"Copy package name");
    assert(!classes.has("tooltip-visible"));
});

test("Icon links preserve downloads and external repository navigation", () => {
    const escape = value=>String(value).replaceAll('"',"&quot;");
    const link = iconAction("download","Download bundle",escape,{href:"https://example.test/bundle"});
    assert.match(link,/href="https:\/\/example.test\/bundle"/);
    assert.match(link,/aria-label="Download bundle"/);
    assert.match(link,/target="_blank" rel="noopener noreferrer"/);
    const disabled = iconAction("link","Copy URL",escape,{copy:"https://api.test",disabled:true});
    assert.match(disabled,/disabled/);
    assert.match(disabled,/data-copy-text="https:\/\/api.test"/);
});

test("Reseam import choices close on Escape while an option has keyboard focus", () => {
    const markup = importFormatAction(value => value, "https://api.test/urv", "https://api.test/reseam", true);
    assert.match(markup, /Registry URL \(URV\)/);
    assert.match(markup, /Reseam Manager JSON/);
    assert.match(markup, /data-copy-text="https:\/\/api.test\/reseam"/);
    const options = {hidden:true}, attributes = new Map();
    const parent = Object.assign(new EventTarget(), {querySelector:()=>options});
    const trigger = Object.assign(new EventTarget(), {
        parentElement:parent,
        classList:{contains:name=>name==="copy-format-trigger",add(){},remove(){}},
        setAttribute:(key,value)=>attributes.set(key,value),
        hasAttribute:()=>false,
        focus(){this.focused=true;}
    });
    bindActions({querySelectorAll:()=>[trigger]});
    trigger.dispatchEvent(new Event("click",{cancelable:true}));
    assert.equal(options.hidden,false);
    assert.equal(attributes.get("aria-expanded"),"true");
    // In the browser, an Escape keydown from the focused option bubbles to its menu.
    const escape = Object.assign(new Event("keydown",{cancelable:true}),{key:"Escape"});
    parent.dispatchEvent(escape);
    assert.equal(options.hidden,true);
    assert.equal(attributes.get("aria-expanded"),"false");
    assert.equal(trigger.focused,true);
    assert.equal(escape.defaultPrevented,true);
});


test("Release search combines version and channel without always showing the reset option", () => {
    const options = [{label:"All versions", value:""},
        {label:"v2.0.0 - Release", value:"v2.0.0"},
        {label:"v2.0.0-dev.3 - Prerelease", value:"v2.0.0-dev.3"}];
    assert.deepEqual(matchingOptions(options, "v2.0.0 dev.3"), [options[2]]);
    assert.deepEqual(matchingOptions(options, "all versions"), [options[0]]);
});

// A small element double covering the DOM surface createFilterPicker uses.
class FakeElement {
    constructor(tag = "div") {
        Object.assign(this, {tagName: tag.toUpperCase(), children: [], parent: null, handlers: {}, attrs: {},
            dataset: {}, style: {}, hidden: false, disabled: false, value: "", textContent: "", id: "",
            tabIndex: 0, scrollTop: 0, scrollHeight: 120, offsetHeight: 30, open: false});
    }
    get isConnected() { return Boolean(this.parent?.isConnected ?? this.connected); }
    append(...nodes) { nodes.forEach(node => { node.parent = this; this.children.push(node); }); }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parent = null; }); this.children = []; this.append(...nodes); }
    after(node) { node.parent = this.parent; this.parent?.children.push(node); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    contains(node) { for (; node; node = node.parent) if (node === this) return true; return false; }
    closest(selector) { return selector === "button" && this.tagName === "BUTTON" ? this : this.parent?.closest?.(selector) ?? null; }
    querySelector() { return this.children.find(child => "pickerValue" in child.dataset) ?? null; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    addEventListener(name, fn) { (this.handlers[name] ??= []).push(fn); }
    removeEventListener(name, fn) { this.handlers[name] = (this.handlers[name] || []).filter(item => item !== fn); }
    dispatchEvent(event) {
        if (event instanceof Event) event = {type: event.type, bubbles: event.bubbles};
        event.target ??= this;
        event.preventDefault ??= () => {}; event.stopPropagation ??= () => {};
        for (let node = this; node; node = event.bubbles ? node.parent : null)
            (node.handlers[event.type] || []).forEach(fn => fn(event));
    }
    focus() { globalThis.document.activeElement = this; }
    getBoundingClientRect() { return {top: 100, bottom: 140, left: 10, width: 300}; }
    matches(selector) { return selector === ":popover-open" && this.open; }
    showPopover() { this.toggle(true); }
    hidePopover() { this.toggle(false); }
    toggle(open) {
        if (this.open === open) return;
        this.dispatchEvent({type: "beforetoggle", newState: open ? "open" : "closed"});
        this.open = open;
        this.dispatchEvent({type: "toggle", newState: open ? "open" : "closed"});
    }
}

test("Filter picker opens, searches, selects with a change event, and returns focus", async t => {
    const {createFilterPicker} = await import("../../shared/source-picker.js");
    const prior = {document: globalThis.document, window: globalThis.window, matchMedia: globalThis.matchMedia};
    const root = new FakeElement("body");
    root.connected = true;
    globalThis.document = Object.assign(new FakeElement("document"), {
        activeElement: null, documentElement: {clientWidth: 1024, clientHeight: 768},
        createElement: tag => new FakeElement(tag)
    });
    globalThis.window = new FakeElement("window");
    globalThis.matchMedia = () => ({matches: false});
    t.after(() => Object.assign(globalThis, prior));

    const field = new FakeElement("div");
    root.append(field);
    const button = new FakeElement("button");
    button.id = "source-picker";
    const value = new FakeElement("span");
    value.dataset.pickerValue = "";
    button.append(value);
    const label = new FakeElement("label");
    const options = [{label: "All sources", value: ""}, {label: "Video", value: "https://github.com/o/video"},
        {label: "Music", value: "https://git.example/o/music"}];
    const select = Object.assign(new FakeElement("select"), {labels: [label], options});
    Object.defineProperty(select, "selectedOptions", {get: () => options.filter(option => option.value === select.value)});
    field.append(label, select, button);
    const changes = [];
    select.addEventListener("change", () => changes.push(select.value));

    createFilterPicker({button, select, label: "Choose a source", searchLabel: "Search sources", showValue: true});
    const panel = field.children.find(child => child.id === "source-picker-options");
    const [search, list] = panel.children;
    assert.equal(select.hidden, true);
    assert.equal(button.hidden, false);
    assert.equal(label.htmlFor, "source-picker");
    assert.equal(value.textContent, "All sources");

    button.dispatchEvent({type: "click", detail: 0});
    assert(panel.open);
    assert.equal(button.attrs["aria-expanded"], "true");
    assert.equal(document.activeElement, search);
    assert.equal(document.handlers.scroll?.length, 1);

    search.value = "music";
    search.dispatchEvent({type: "input"});
    assert.deepEqual(list.children.map(choice => choice.dataset.value), ["https://git.example/o/music"]);

    list.dispatchEvent({type: "click", target: list.children[0]});
    assert.deepEqual(changes, ["https://git.example/o/music"]);
    assert.equal(value.textContent, "Music");
    assert(!panel.open);
    assert.equal(button.attrs["aria-expanded"], "false");
    assert.equal(document.activeElement, button);
    assert.equal(document.handlers.scroll.length, 0);

    // Escape closes without changing the value, and detaching an open panel drops its listeners.
    button.dispatchEvent({type: "click", detail: 0});
    panel.dispatchEvent({type: "keydown", key: "Escape"});
    assert(!panel.open);
    assert.deepEqual(changes, ["https://git.example/o/music"]);
    button.dispatchEvent({type: "click", detail: 0});
    field.remove();
    document.handlers.scroll[0]({target: document});
    assert.equal(document.handlers.scroll.length, 0);
    assert.equal(window.handlers.resize.length, 0);
});

test("Copying an import choice returns keyboard focus to the menu trigger",async t=>{
    t.mock.timers.enable({apis:["setTimeout"]});
    const attributes=new Map(),options={hidden:false},tip={},classes=new Set(["copy-format-option"]);
    const trigger=Object.assign(new EventTarget(),{
        classList:{contains:()=>true},parentElement:null,
        setAttribute:(key,value)=>attributes.set(key,value),
        focus(){this.focused=true;}
    });
    const menu=Object.assign(new EventTarget(),{
        querySelector:selector=>selector===".copy-format-options"?options:trigger
    });
    trigger.parentElement=menu;
    const option=Object.assign(new EventTarget(),{
        dataset:{copyText:"https://api.test/reseam",tooltip:"Copy Reseam Manager JSON"},
        classList:{contains:name=>classes.has(name),add:name=>classes.add(name),remove:name=>classes.delete(name)},
        hasAttribute:name=>name==="data-copy-text",
        querySelector:()=>tip,closest:selector=>selector===".copy-format-menu"?menu:null,
        setAttribute(){}
    });
    const previous=Object.getOwnPropertyDescriptor(globalThis,"navigator"),copied=[];
    Object.defineProperty(globalThis,"navigator",{configurable:true,value:{
        clipboard:{writeText:async value=>copied.push(value)}
    }});
    t.after(()=>{
        if(previous)Object.defineProperty(globalThis,"navigator",previous);
        else delete globalThis.navigator;
    });
    bindActions({querySelectorAll:selector=>selector===".copy-format-trigger"?[trigger]:[option]});
    option.dispatchEvent(new Event("click",{cancelable:true}));
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(copied,["https://api.test/reseam"]);
    assert.equal(options.hidden,true);
    assert.equal(attributes.get("aria-expanded"),"false");
    assert.equal(trigger.focused,true);
});
