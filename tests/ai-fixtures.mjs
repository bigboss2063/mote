import { build } from "esbuild";
import vm from "node:vm";

export function makeMemo(overrides = {}) {
  const date = overrides.date ?? "2026-01-01";
  const time = overrides.time ?? "10:00";
  const content = overrides.content ?? "";
  return {
    file: overrides.file ?? `Mote/${date.slice(0, 4)}/${date} ${time.replace(":", ".")}.md`,
    date,
    time,
    datetime: overrides.datetime ?? new Date(`${date}T${time}:00`),
    content,
    tags: overrides.tags ?? [],
    hasImage: overrides.hasImage ?? false,
    hasLink: overrides.hasLink ?? false,
    isPinned: overrides.isPinned ?? false,
    isStarred: overrides.isStarred ?? false,
    hasOpenTask: overrides.hasOpenTask ?? false,
    hasClosedTask: overrides.hasClosedTask ?? false,
  };
}

export async function loadTs(
  entry,
  requireImpl = () => ({}),
  globals = {}
) {
  const bundle = await build({
    entryPoints: [entry],
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
    require: requireImpl,
    // A fresh VM context only has V8 intrinsics; Node globals the bundled
    // code may touch (console, URL, streaming primitives) must be passed in.
    console: { debug() {}, log() {}, info() {}, warn() {}, error() {} },
    URL,
    ...globals,
  });
  return module.exports;
}
