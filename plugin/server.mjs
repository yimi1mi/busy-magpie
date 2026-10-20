// magpie probes exports["./server"] for a provider plugin. Busy Magpie is a
// launcher, not a provider: this stub keeps magpie from trying to load the
// Electron main process as a plugin. The launcher lives in launch.hooks.mjs.
export default async () => ({});
