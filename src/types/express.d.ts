export {};

import { ClientPlatform } from "../types/platform";
import { RoleKey } from "../types/rbac";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username: string;
        role: RoleKey | string;
        roles?: string[];
        permissions?: string[];
      };
      clientPlatform?: ClientPlatform;
      requestId?: string;
      traceId?: string;
    }
  }
}
