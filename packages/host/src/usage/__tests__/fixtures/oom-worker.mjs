import "./no-network.mjs";
import { parentPort, workerData } from "node:worker_threads";
const post = parentPort.postMessage.bind(parentPort);
let ready;
const opened = new Promise(resolve => { ready = resolve; });
parentPort.postMessage = (event, ...rest) => {
  post(event, ...rest);
  if (event?.type === "snapshot") ready();
};
await import(workerData.fixtureBundle);
await opened;
const retained = [];
for (;;) retained.push(Array.from({ length: 100000 }, (_, i) => ({ i })));
