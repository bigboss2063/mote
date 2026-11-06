import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/caret-position.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"],
});
const module = {exports: {}};
vm.runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, require: () => ({}),
});
const {placePopup} = module.exports;

const viewport = {width: 800, height: 600};
const anchor = (left, top, height = 20) => ({left, top, height});

test("popup sits right under the caret line", () => {
  assert.deepEqual(
    {...placePopup(anchor(100, 100), {width: 200, height: 150}, viewport)},
    {left: 100, top: 124}
  );
});

test("flips above the caret when the bottom is tight", () => {
  assert.equal(placePopup(anchor(100, 500), {width: 200, height: 150}, viewport).top, 346);
});

test("clamps into the viewport on both axes", () => {
  // 右边溢出
  assert.equal(placePopup(anchor(750, 100), {width: 200, height: 150}, viewport).left, 592);
  // 上方也放不下：贴 margin
  assert.equal(placePopup(anchor(100, 100), {width: 200, height: 570}, viewport).top, 8);
  // 比视口还宽：贴左边 margin
  assert.equal(placePopup(anchor(300, 100), {width: 900, height: 50}, viewport).left, 8);
});
