import crypto from "node:crypto";
import { randomToken } from "../util/random.js";

export interface AuthPayload {
  token?: string;
  password?: string;
}

export interface AuthServiceOptions {
  password?: string;
  token?: string;
}

const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
};

export class AuthService {
  public readonly token: string;
  private readonly password?: string;

  public constructor(options?: string | AuthServiceOptions) {
    if (typeof options === "string" || options === undefined) {
      // Backward-compatible: single password argument.
      this.password = options;
      this.token = randomToken();
    } else {
      this.password = options.password;
      this.token = options.token ?? randomToken();
    }
  }

  public requiresPassword(): boolean {
    return Boolean(this.password);
  }

  public verify(payload: AuthPayload): { ok: boolean; reason?: string } {
    if (!payload.token || !safeEqual(payload.token, this.token)) {
      return { ok: false, reason: "invalid token" };
    }

    if (this.password && (!payload.password || !safeEqual(payload.password, this.password))) {
      return { ok: false, reason: "invalid password" };
    }

    return { ok: true };
  }
}
