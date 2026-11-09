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
const { navbarClearancePx } = module.exports;

const bar = (top, height = 52, width = 390) => ({ top, height, width });

test("lifts bottom UI above a navbar that overlaps the viewport", () => {
  // 视口 844，导航顶在 758：重叠 86，再加 8px 空隙。
  assert.equal(navbarClearancePx(844, bar(758)), 94);
});

test("returns 0 when the navbar is hidden below the viewport", () => {
  assert.equal(navbarClearancePx(844, bar(860)), 0);
});

test("returns 0 when the view already ends above the navbar", () => {
  assert.equal(navbarClearancePx(758, bar(758)), 0);
  assert.equal(navbarClearancePx(720, bar(758)), 0);
});

test("returns 0 when there is no measurable navbar", () => {
  assert.equal(navbarClearancePx(844, null), 0);
  assert.equal(navbarClearancePx(844, bar(700, 0)), 0);
  assert.equal(navbarClearancePx(844, bar(700, 52, 0)), 0);
});
