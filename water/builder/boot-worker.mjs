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
parentPort.on('message', (d) => { try { self.onmessage?.({ data: d }); } catch (e) { parentPort.postMessage({ type: 'error', message: String(e?.message || e) }); } });
await import(pathToFileURL(workerData.file).href);
