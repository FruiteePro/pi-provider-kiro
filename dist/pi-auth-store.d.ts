import { type KiroCredentials } from "./oauth.js";
/**
 * Read pi's own persisted Kiro credential. Returns undefined when the file is
 * missing, unparseable, lacks a usable kiro entry, or the access token has
 * expired. Never logs file contents because auth.json holds many providers'
 * secrets.
 */
export declare function getPiHostKiroCredentials(agentDir?: string): KiroCredentials | undefined;
/** Also expose expired credentials so a rejected access token can be renewed. */
export declare function getPiHostKiroCredentialsAllowExpired(agentDir?: string): KiroCredentials | undefined;
export declare function getPiHostKiroCredentialsForToken(token: string, agentDir?: string): KiroCredentials | undefined;
/**
 * Recover the native /login credential, not an unrelated CLI/IDE account. A 403
 * overrides the local expiry: always perform the grant when the token matches.
 * Uses Pi's cross-process lock protocol through refresh + atomic persistence, so
 * the rotated refresh token is saved without overwriting other provider entries.
 * A refresh already started survives request cancellation, with its own deadline.
 */
export declare function refreshPiHostKiroCredentials(rejectedToken: string, agentDir?: string): Promise<KiroCredentials | undefined>;
