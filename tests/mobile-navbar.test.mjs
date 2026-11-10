import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/mobile-navbar.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["obsidian"],
});
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
  require: () => ({ Platform: { isMobile: true } }),
});
const { navbarClearancePx, clearancePx } = module.exports;

const bar = (top, height = 52, width = 390) => ({ top, height, width });

test("lifts bottom UI above a navbar that overlaps the viewport", () => {
  // 视口 844，导航顶在 758：重叠 86，再加 24px 空隙。
  assert.equal(navbarClearancePx(844, bar(758)), 110);
});

test("keeps a gap when the view ends flush with the navbar", () => {
  assert.equal(navbarClearancePx(758, bar(758)), 24);
  // 已经高出 8px，补到 24px，而不是当成完全让开。
  assert.equal(navbarClearancePx(750, bar(758)), 16);
});

test("returns 0 when the navbar is already clear of the view", () => {
  assert.equal(navbarClearancePx(844, bar(900)), 0);
  assert.equal(navbarClearancePx(720, bar(758)), 0);
});

test("uses the highest cover when the keyboard sits above the navbar", () => {
  // 视口底 800，导航顶 720，键盘顶 500：以键盘为准。
  assert.equal(clearancePx(800, [720, 500]), 324);
});

test("ignores a cover that sits below the target", () => {
  assert.equal(clearancePx(700, [900]), 0);
  // 导航在下面，键盘才挡住。
  assert.equal(clearancePx(800, [900, 640]), 184);
});

test("returns 0 when there is no measurable navbar", () => {
  assert.equal(navbarClearancePx(844, null), 0);
  assert.equal(navbarClearancePx(844, bar(700, 0)), 0);
  assert.equal(navbarClearancePx(844, bar(700, 52, 0)), 0);
});
