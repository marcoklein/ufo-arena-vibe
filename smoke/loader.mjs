// Resolve hook that maps the bare "three" specifier to the local mock, so the
// real game code can boot inside Node without a browser or a network.
//
//   node --import ./smoke/loader.mjs smoke/run.mjs
import { registerHooks } from "node:module";

const mock = new URL("./three-mock.js", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "three") return { url: mock, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
