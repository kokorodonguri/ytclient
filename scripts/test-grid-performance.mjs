import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

async function fixture() {
  const observers = [];
  let now = 1000000;
  class Element {
    writes = 0;
    html = "";
    children = [];
    set innerHTML(value) { this.html = value; this.writes++; this.children = []; }
    get innerHTML() { return this.html; }
    setAttribute() {}
    removeAttribute() {}
    appendChild(child) { this.children.push(child); child.parent = this; }
    remove() { this.parent.children = this.parent.children.filter((c) => c !== this); }
    getBoundingClientRect() { return { top: 10000 }; }
    insertAdjacentHTML(_position, html) { this.parent.html += html; }
  }
  const context = vm.createContext({
    console,
    Date: class extends Date { static now() { return now; } },
    document: { activeElement: null, createElement: () => new Element() },
    window: { innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
  });
  const grid = new vm.SourceTextModule(fs.readFileSync("src/frontend/grid.js", "utf8"), { context });
  const utils = new vm.SourceTextModule(fs.readFileSync("src/frontend/utils.js", "utf8"), { context });
  const constants = new vm.SyntheticModule(["MESSAGES"], function () {
    this.setExport("MESSAGES", { INFO: {}, ERROR: {} });
  }, { context });
  await grid.link((name) => name === "./utils.js" ? utils : constants);
  await grid.evaluate();
  const container = new Element();
  const input = { value: "" };
  const state = {
    currentMode: "official", currentSelectedChannel: "ALL",
    appData: { official: [], clips: [], is_building: false },
  };
  const render = () => grid.namespace.renderGrid(state, {
    getGridContainer: () => container,
    getDOM: (key) => key === "freeWordInput" ? input : null,
  });
  return { container, input, state, render, observers, tick: (ms) => { now += ms; } };
}

function videos(count) {
  return Array.from({ length: count }, (_, i) => ({
    video_id: String(i), title: `video ${i}`, uploader: "channel",
    timestamp: 900 - i, thumbnail: `https://example.test/${i}.jpg`,
  }));
}

test("equivalent feed replacements preserve already appended cards", async () => {
  const f = await fixture();
  f.state.appData.official = videos(4000);
  f.render();
  f.observers[0].callback([{ isIntersecting: true }]);
  const html = f.container.html;
  f.state.appData.official = f.state.appData.official.map((v) => ({ ...v }));
  f.render();
  assert.equal(f.container.writes, 1);
  assert.equal(f.container.html, html);
  assert.equal(f.observers.length, 1);
});

test("unrendered changes are picked up by the next chunk without rebuilding", async () => {
  const f = await fixture();
  f.state.appData.official = videos(130);
  f.render();
  f.state.appData.official = f.state.appData.official.map((v) => ({ ...v }));
  f.state.appData.official[65].title = "new pending title";
  f.render();
  assert.equal(f.container.writes, 1);
  f.observers[0].callback([{ isIntersecting: true }]);
  assert.match(f.container.html, /new pending title/);
});

test("visible mutations and relative time boundaries invalidate reuse", async () => {
  const f = await fixture();
  f.state.appData.official = videos(1);
  f.render();
  f.state.appData.official[0].title = "changed";
  f.render();
  assert.equal(f.container.writes, 2);
  assert.match(f.container.html, /changed/);
  f.tick(60000);
  f.render();
  assert.equal(f.container.writes, 3);
});

test("search supports frozen data and invalidates changed titles", async () => {
  const f = await fixture();
  f.state.appData.official = videos(2);
  Object.freeze(f.state.appData.official[0]);
  f.input.value = "video";
  assert.equal(f.render(), 2);
  assert.equal("_searchIndex" in f.state.appData.official[1], false);
  f.state.appData.official[1].title = "replacement";
  f.input.value = "replacement";
  assert.equal(f.render(), 1);
  assert.match(f.container.html, /replacement/);
});

test("stale observer callbacks cannot append into a replacement grid", async () => {
  const f = await fixture();
  f.state.appData.official = videos(150);
  f.render();
  f.state.appData.official[0].title = "changed";
  f.render();
  const html = f.container.html;
  f.observers[0].callback([{ isIntersecting: true }]);
  assert.equal(f.container.html, html);
  f.observers[1].callback([{ isIntersecting: true }]);
  assert.notEqual(f.container.html, html);
});

test("invalid data cancels pending work and allows recovery", async () => {
  const f = await fixture();
  const items = videos(150);
  f.state.appData.official = items;
  f.render();
  f.state.appData.official = null;
  f.render();
  assert.equal(f.observers[0].disconnected, true);
  const html = f.container.html;
  f.observers[0].callback([{ isIntersecting: true }]);
  assert.equal(f.container.html, html);
  f.state.appData.official = items;
  assert.equal(f.render(), 150);
  assert.match(f.container.html, /video-card/);
});
