export function obsidianStub(overrides = {}) {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property];
      return function Stub() {};
    },
  });
}
