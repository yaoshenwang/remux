/**
 * E2EE encryption layer for Remux WebSocket messages.
 * Uses X25519 key exchange + HKDF-SHA256 key derivation + AES-256-GCM encryption.
 *
 * Design references:
 * - Signal Protocol (X25519 + AES-GCM): https://signal.org/docs/specifications/x3dh/
 * - Mosh: AES-128-OCB transport encryption with sequence numbers
 * - Node.js crypto docs: https://nodejs.org/api/crypto.html
 */

import crypto from "crypto";

// ── Constants ──────────────────────────────────────────────────────

const HKDF_SALT = "remux-e2ee-v1";
const HKDF_INFO = "aes-256-gcm";
const AES_KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM
const IV_PREFIX_LENGTH = 4; // fixed prefix bytes in IV
const IV_COUNTER_LENGTH = 8; // counter bytes in IV
const AUTH_TAG_LENGTH = 16; // 128 bits

// ── Key pair generation ────────────────────────────────────────────

/**
 * Generate an X25519 key pair for ECDH key exchange.
 * Returns raw 32-byte public and private key buffers.
 */
export function generateKeyPair(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  // X25519 DER-encoded SPKI public key: 12-byte header + 32-byte raw key
  // X25519 DER-encoded PKCS8 private key: 16-byte header + 32-byte raw key
  const rawPublic = publicKey.subarray(publicKey.length - 32);
  const rawPrivate = privateKey.subarray(privateKey.length - 32);

  return {
    publicKey: Buffer.from(rawPublic),
    privateKey: Buffer.from(rawPrivate),
  };
}

// ── Shared secret derivation ───────────────────────────────────────

/**
 * Derive a shared AES-256-GCM key from our private key and the peer's public key.
 * Uses X25519 ECDH followed by HKDF-SHA256 key derivation.
 */
export function deriveSharedSecret(
  privateKey: Buffer,
  peerPublicKey: Buffer,
): Buffer {
  // Reconstruct CryptoKey objects from raw buffers
  const privKeyObj = crypto.createPrivateKey({
    key: buildPkcs8(privateKey),
    format: "der",
    type: "pkcs8",
  });

  const pubKeyObj = crypto.createPublicKey({
    key: buildSpki(peerPublicKey),
    format: "der",
    type: "spki",
  });

  // X25519 ECDH to get raw shared secret
  const rawSecret = crypto.diffieHellman({
    privateKey: privKeyObj,
    publicKey: pubKeyObj,
  });

  // HKDF-SHA256 to derive the final 256-bit AES key
  const salt = Buffer.from(HKDF_SALT, "utf8");
  const info = Buffer.from(HKDF_INFO, "utf8");
  const derived = crypto.hkdfSync("sha256", rawSecret, salt, info, AES_KEY_LENGTH);

  return Buffer.from(derived);
}

/**
 * Build a DER-encoded PKCS8 wrapper around a raw 32-byte X25519 private key.
 */
function buildPkcs8(rawKey: Buffer): Buffer {
  // PKCS8 header for X25519: 302e020100300506032b656e042204 20
  const header = Buffer.from(
    "302e020100300506032b656e04220420",
    "hex",
  );
  return Buffer.concat([header, rawKey]);
}

/**
 * Build a DER-encoded SPKI wrapper around a raw 32-byte X25519 public key.
 */
function buildSpki(rawKey: Buffer): Buffer {
  // SPKI header for X25519: 302a300506032b656e032100
  const header = Buffer.from("302a300506032b656e032100", "hex");
  return Buffer.concat([header, rawKey]);
}

// ── Encrypt / Decrypt ──────────────────────────────────────────────

/**
 * Encrypt a plaintext buffer using AES-256-GCM.
 *
 * IV construction: 4 bytes fixed random prefix + 8 bytes counter (big-endian).
 * This ensures unique IVs per message while the counter provides ordering.
 */
export function encrypt(
  key: Buffer,
  plaintext: Buffer,
  counter: bigint,
): { ciphertext: Buffer; tag: Buffer; iv: Buffer } {
  // Build IV: 4 bytes random prefix + 8 bytes counter (big-endian)
  const iv = Buffer.alloc(IV_LENGTH);
  crypto.randomFillSync(iv, 0, IV_PREFIX_LENGTH);
  iv.writeBigUInt64BE(counter, IV_PREFIX_LENGTH);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return { ciphertext: encrypted, tag, iv };
}

/**
 * Decrypt a ciphertext buffer using AES-256-GCM.
 * Verifies the auth tag; throws on tampered data.
 */
export function decrypt(
  key: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  iv: Buffer,
): Buffer {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── E2EESession ────────────────────────────────────────────────────

/**
 * Manages an E2EE session for a single WebSocket connection.
 * Handles key exchange, counter management, and anti-replay protection.
 */
export class E2EESession {
  private sharedKey: Buffer | null = null;
  private sendCounter: bigint = 0n;
  private recvCounter: bigint = -1n; // last received counter; -1 means none yet
  private localKeyPair: { publicKey: Buffer; privateKey: Buffer };

  constructor() {
    this.localKeyPair = generateKeyPair();
  }

  /** Get our public key as a base64-encoded string for transmission. */
  getPublicKey(): string {
    return this.localKeyPair.publicKey.toString("base64");
  }

  /**
   * Complete the ECDH handshake with the peer's base64-encoded public key.
   * After this, encrypt/decrypt operations become available.
   */
  completeHandshake(peerPublicKeyB64: string): void {
    const peerPublicKey = Buffer.from(peerPublicKeyB64, "base64");
    this.sharedKey = deriveSharedSecret(
      this.localKeyPair.privateKey,
      peerPublicKey,
    );
  }

  /**
   * Encrypt a plaintext string for sending.
   * Returns a base64-encoded string containing: iv (12) + ciphertext (variable) + tag (16).
   * Increments the send counter after each call.
   */
  encryptMessage(plaintext: string): string {
    if (!this.sharedKey) {
      throw new Error("E2EE handshake not completed");
    }

    const plaintextBuf = Buffer.from(plaintext, "utf8");
    const { ciphertext, tag, iv } = encrypt(
      this.sharedKey,
      plaintextBuf,
      this.sendCounter,
    );
    this.sendCounter++;

    // Pack: iv (12) + ciphertext (N) + tag (16)
    const packed = Buffer.concat([iv, ciphertext, tag]);
    return packed.toString("base64");
  }

  /**
   * Decrypt a base64-encoded encrypted message.
   * Validates that the counter is monotonically increasing (anti-replay).
   */
  decryptMessage(encrypted: string): string {
    if (!this.sharedKey) {
      throw new Error("E2EE handshake not completed");
    }

    const packed = Buffer.from(encrypted, "base64");

    // Unpack: iv (12) + ciphertext (N) + tag (16)
    if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error("E2EE message too short");
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH, packed.length - AUTH_TAG_LENGTH);
    const tag = packed.subarray(packed.length - AUTH_TAG_LENGTH);

    // Extract counter from IV for anti-replay check
    const counter = iv.readBigUInt64BE(IV_PREFIX_LENGTH);
    if (counter <= this.recvCounter) {
      throw new Error("E2EE replay detected: counter not monotonically increasing");
    }

    const decrypted = decrypt(this.sharedKey, ciphertext, tag, iv);
    this.recvCounter = counter;

    return decrypted.toString("utf8");
  }

  /** Whether the handshake has been completed and encryption is available. */
  isEstablished(): boolean {
    return this.sharedKey !== null;
  }
}
