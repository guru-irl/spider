import http from "node:http";
import https from "node:https";
const forbidden = () => { throw new Error("fixture-network-forbidden"); };
globalThis.fetch = forbidden;
http.request = http.get = https.request = https.get = forbidden;
