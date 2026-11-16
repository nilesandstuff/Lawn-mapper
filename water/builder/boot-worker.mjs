/**
 * A WEB WORKER IN A NODE THREAD (the water builder): the shade light worker (lib/shade/light-worker.js) runs as it does
 * in the browser -- self.onmessage in, self.postMessage out -- over worker_threads.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register('./loader.mjs', import.meta.url, { data: { root: workerData.root } });
globalThis.self = globalThis;
self.postMessage = (m) => parentPort.postMessage(m);
const deliver = (d) => { try { self.onmessage?.({ data: d }); } catch (e) { parentPort.postMessage({ type: 'error', message: String(e?.message || e) }); } };
// a message sent before the module has loaded (a browser queues it the same way) waits, then goes in order
let early = [];
parentPort.on('message', (d) => { if (early) early.push(d); else deliver(d); });
await import(pathToFileURL(workerData.file).href);
const held = early; early = null;
for (const d of held) deliver(d);
