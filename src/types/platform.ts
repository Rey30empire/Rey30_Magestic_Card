export const CLIENT_PLATFORMS = ["desktop", "mobile", "web"] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];
