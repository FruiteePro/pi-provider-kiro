import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
export declare const SSO_OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
export declare const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export declare const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
/**
 * The profile ARN a Builder ID session uses, or undefined for any other start URL.
 * Builder ID has no profiles to list (ListAvailableProfiles answers 403), and its
 * stored sessions carry no ARN, so every Builder ID credential takes this fixed one.
 */
export declare function builderIdProfileArn(startUrl: unknown): string | undefined;
export declare const KIRO_DESKTOP_REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
export declare const SSO_SCOPES: string[];
export type KiroAuthMethod = "idc" | "desktop" | "external-idp" | "apikey";
export type KiroLoginMethod = "auto" | "builder-id" | "google" | "github";
export interface KiroCredentials extends OAuthCredentials {
    clientId: string;
    clientSecret: string;
    region: string;
    authMethod: KiroAuthMethod;
    /** Required for Google/GitHub social profiles; ListAvailableProfiles may return empty for these tokens. */
    profileArn?: string;
    startUrl?: string;
    isEnterprise?: boolean;
}
export declare const KIRO_DESKTOP_USER_AGENT = "Kiro-Desktop/0.2.13 (darwin; arm64)";
export declare function kiroUserAgent(service: string, sdkVersion: string): Record<string, string>;
export declare function kiroAuthHeaders(token: string): Record<string, string>;
export declare function isApiKey(token: string): boolean;
export declare function loginKiroWithApiKey(callbacks: OAuthLoginCallbacks, apiKey: string): Promise<OAuthCredentials>;
/**
 * Login to Kiro using the specified method.
 *
 * - "auto": Use existing kiro-cli credentials if available (any method)
 * - "builder-id": AWS Builder ID via device code flow
 * - "google" | "github": Social login via kiro-cli (requires kiro-cli installed)
 */
export declare function loginKiro(callbacks: OAuthLoginCallbacks, preferredMethod?: KiroLoginMethod): Promise<OAuthCredentials>;
/**
 * Backward-compatible alias for loginKiro with Builder ID.
 * @deprecated Use loginKiro instead.
 */
export declare function loginKiroBuilderID(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
export declare function refreshKiroToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
/** Refresh only this session; recovery must not substitute a cached account. */
export declare function refreshKiroTokenDirect(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
