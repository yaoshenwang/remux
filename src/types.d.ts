declare module "qrcode-terminal" {
  export function generate(
    text: string,
    options?: { small?: boolean },
    callback?: (code: string) => void,
  ): void;
}

declare module "web-push" {
  export interface PushSubscription {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  }

  export interface RequestOptions {
    TTL?: number;
    headers?: Record<string, string>;
    vapidDetails?: {
      subject: string;
      publicKey: string;
      privateKey: string;
    };
  }

  export interface SendResult {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  }

  export interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }

  export function generateVAPIDKeys(): VapidKeys;
  export function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string,
  ): void;
  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer | null,
    options?: RequestOptions,
  ): Promise<SendResult>;
}
