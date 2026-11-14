export type { IntercomBrokerPort } from './local.js';
export { registerIntercomOnce, registerIntercomOnce as default, intercomConflict, INTERCOM_CONFLICT_MESSAGE } from './single-instance.js';
export type { SessionAddress, SessionEndpoint, FederationPort, FederationBridge, FederationBlockers, FederationDispatchResult, AcceptanceEvidence } from './protocol.js';
