/**
 * E2EE tests for Remux.
 * Tests X25519 key exchange + AES-256-GCM encryption layer.
 *
 * Design reference: Signal Protocol / Mosh E2EE (X25519 ECDH + HKDF + AES-GCM)
 */

import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  deriveSharedSecret,
  encrypt,
  decrypt,
  E2EESession,
} from "../src/gateway/ws/e2ee-session.js";

describe("e2ee", () => {
  // ── Key pair generation ──

  describe("generateKeyPair", () => {
    it("should return publicKey and privateKey buffers", () => {
      const kp = generateKeyPair();
      expect(kp).toHaveProperty("publicKey");
      expect(kp).toHaveProperty("privateKey");
      expect(Buffer.isBuffer(kp.publicKey)).toBe(true);
      expect(Buffer.isBuffer(kp.privateKey)).toBe(true);
    });

    it("should generate 32-byte X25519 keys", () => {
      const kp = generateKeyPair();
      expect(kp.publicKey.length).toBe(32);
      expect(kp.privateKey.length).toBe(32);
    });

    it("should generate unique key pairs each time", () => {
      const kp1 = generateKeyPair();
      const kp2 = generateKeyPair();
      expect(kp1.publicKey.equals(kp2.publicKey)).toBe(false);
      expect(kp1.privateKey.equals(kp2.privateKey)).toBe(false);
    });
  });

  // ── Shared secret derivation ──

  describe("deriveSharedSecret", () => {
    it("should derive the same shared secret on both sides", () => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();

      const secretA = deriveSharedSecret(alice.privateKey, bob.publicKey);
      const secretB = deriveSharedSecret(bob.privateKey, alice.publicKey);

      expect(secretA.equals(secretB)).toBe(true);
    });

    it("should return a 32-byte key (256-bit AES key)", () => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const secret = deriveSharedSecret(alice.privateKey, bob.publicKey);
      expect(secret.length).toBe(32);
    });

    it("should produce different secrets with different peers", () => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const carol = generateKeyPair();

      const secretAB = deriveSharedSecret(alice.privateKey, bob.publicKey);
      const secretAC = deriveSharedSecret(alice.privateKey, carol.publicKey);

      expect(secretAB.equals(secretAC)).toBe(false);
    });
  });

  // ── Encrypt / Decrypt round-trip ──

  describe("encrypt / decrypt", () => {
    it("should round-trip encrypt and decrypt", () => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const key = deriveSharedSecret(alice.privateKey, bob.publicKey);

      const plaintext = Buffer.from("hello, encrypted world!");
      const { ciphertext, tag, iv } = encrypt(key, plaintext, 0n);

      const decrypted = decrypt(key, ciphertext, tag, iv);
      expect(decrypted.toString("utf8")).toBe("hello, encrypted world!");
    });

    it("should produce different ciphertext with different counters", () => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const key = deriveSharedSecret(alice.privateKey, bob.publicKey);

      const plaintext = Buffer.from("same message");
      const enc1 = encrypt(key, plaintext, 0n);
      const enc2 = encrypt(key, plaintext, 1n);

      expect(enc1.ciphertext.equals(enc2.ciphertext)).toBe(false);
      expect(enc1.iv.equals(enc2.iv)).toBe(false);
    });

    it("should produce 12-byte IV", () => {
      const key = deriveSharedSecret(
        generateKeyPair().privateKey,
        generateKeyPair().publicKey,
      );
      const { iv } = encrypt(key, Buffer.from("test"), 0n);
      expect(iv.length).toBe(12);
    });

    it("should produce 16-byte auth tag", () => {
      const key = deriveSharedSecret(
        generateKeyPair().privateKey,
        generateKeyPair().publicKey,
      );
      const { tag } = encrypt(key, Buffer.from("test"), 0n);
      expect(tag.length).toBe(16);
    });

    it("should fail to decrypt with wrong key", () => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const carol = generateKeyPair();

      const rightKey = deriveSharedSecret(alice.privateKey, bob.publicKey);
      const wrongKey = deriveSharedSecret(alice.privateKey, carol.publicKey);

      const plaintext = Buffer.from("secret data");
      const { ciphertext, tag, iv } = encrypt(rightKey, plaintext, 0n);

      expect(() => decrypt(wrongKey, ciphertext, tag, iv)).toThrow();
    });

    it("should fail to decrypt with tampered ciphertext", () => {
      const key = deriveSharedSecret(
        generateKeyPair().privateKey,
        generateKeyPair().publicKey,
      );

      const plaintext = Buffer.from("untampered message");
      const { ciphertext, tag, iv } = encrypt(key, plaintext, 0n);

      // Flip a bit in the ciphertext
      const tampered = Buffer.from(ciphertext);
      tampered[0] ^= 0xff;

      expect(() => decrypt(key, tampered, tag, iv)).toThrow();
    });

    it("should fail to decrypt with tampered auth tag", () => {
      const key = deriveSharedSecret(
        generateKeyPair().privateKey,
        generateKeyPair().publicKey,
      );

      const plaintext = Buffer.from("tagged message");
      const { ciphertext, tag, iv } = encrypt(key, plaintext, 0n);

      const tamperedTag = Buffer.from(tag);
      tamperedTag[0] ^= 0xff;

      expect(() => decrypt(key, ciphertext, tamperedTag, iv)).toThrow();
    });

    it("should handle empty plaintext", () => {
      const key = deriveSharedSecret(
        generateKeyPair().privateKey,
        generateKeyPair().publicKey,
      );

      const plaintext = Buffer.from("");
      const { ciphertext, tag, iv } = encrypt(key, plaintext, 0n);
      const decrypted = decrypt(key, ciphertext, tag, iv);
      expect(decrypted.toString("utf8")).toBe("");
    });

    it("should handle large messages (64KB)", () => {
      const key = deriveSharedSecret(
        generateKeyPair().privateKey,
        generateKeyPair().publicKey,
      );

      const plaintext = Buffer.alloc(65536, 0x42); // 64KB of 'B'
      const { ciphertext, tag, iv } = encrypt(key, plaintext, 0n);
      const decrypted = decrypt(key, ciphertext, tag, iv);
      expect(decrypted.equals(plaintext)).toBe(true);
    });
  });

  // ── E2EESession ──

  describe("E2EESession", () => {
    it("should expose a base64-encoded public key", () => {
      const session = new E2EESession();
      const pubKey = session.getPublicKey();
      expect(typeof pubKey).toBe("string");
      // Should be valid base64
      const decoded = Buffer.from(pubKey, "base64");
      expect(decoded.length).toBe(32);
    });

    it("should not be established before handshake", () => {
      const session = new E2EESession();
      expect(session.isEstablished()).toBe(false);
    });

    it("should complete handshake between two sessions", () => {
      const client = new E2EESession();
      const server = new E2EESession();

      // Exchange public keys
      server.completeHandshake(client.getPublicKey());
      client.completeHandshake(server.getPublicKey());

      expect(client.isEstablished()).toBe(true);
      expect(server.isEstablished()).toBe(true);
    });

    it("should encrypt/decrypt messages after handshake", () => {
      const client = new E2EESession();
      const server = new E2EESession();

      server.completeHandshake(client.getPublicKey());
      client.completeHandshake(server.getPublicKey());

      // Client sends to server
      const encrypted = client.encryptMessage("hello server");
      const decrypted = server.decryptMessage(encrypted);
      expect(decrypted).toBe("hello server");

      // Server sends to client
      const encrypted2 = server.encryptMessage("hello client");
      const decrypted2 = client.decryptMessage(encrypted2);
      expect(decrypted2).toBe("hello client");
    });

    it("should handle multiple messages with incrementing counters", () => {
      const client = new E2EESession();
      const server = new E2EESession();

      server.completeHandshake(client.getPublicKey());
      client.completeHandshake(server.getPublicKey());

      const messages = [
        "first message",
        "second message",
        "third message",
        "unicode: \u4f60\u597d\u4e16\u754c\ud83d\ude00",
      ];

      for (const msg of messages) {
        const enc = client.encryptMessage(msg);
        const dec = server.decryptMessage(enc);
        expect(dec).toBe(msg);
      }
    });

    it("should reject replayed messages (anti-replay)", () => {
      const client = new E2EESession();
      const server = new E2EESession();

      server.completeHandshake(client.getPublicKey());
      client.completeHandshake(server.getPublicKey());

      const encrypted = client.encryptMessage("original message");
      // First decrypt succeeds
      server.decryptMessage(encrypted);
      // Replay: same encrypted message should fail
      expect(() => server.decryptMessage(encrypted)).toThrow();
    });

    it("should throw when encrypting before handshake", () => {
      const session = new E2EESession();
      expect(() => session.encryptMessage("test")).toThrow();
    });

    it("should throw when decrypting before handshake", () => {
      const session = new E2EESession();
      expect(() => session.decryptMessage("dGVzdA==")).toThrow();
    });

    it("should handle concurrent independent sessions", () => {
      // Two separate E2EE channels that don't interfere
      const clientA = new E2EESession();
      const serverA = new E2EESession();
      const clientB = new E2EESession();
      const serverB = new E2EESession();

      serverA.completeHandshake(clientA.getPublicKey());
      clientA.completeHandshake(serverA.getPublicKey());

      serverB.completeHandshake(clientB.getPublicKey());
      clientB.completeHandshake(serverB.getPublicKey());

      // Channel A messages
      const encA = clientA.encryptMessage("channel A");
      const decA = serverA.decryptMessage(encA);
      expect(decA).toBe("channel A");

      // Channel B messages
      const encB = clientB.encryptMessage("channel B");
      const decB = serverB.decryptMessage(encB);
      expect(decB).toBe("channel B");

      // Cross-channel: A's ciphertext should NOT decrypt on B
      const encCross = clientA.encryptMessage("cross-channel test");
      expect(() => serverB.decryptMessage(encCross)).toThrow();
    });

    it("should handle binary-like content (terminal output with control chars)", () => {
      const client = new E2EESession();
      const server = new E2EESession();

      server.completeHandshake(client.getPublicKey());
      client.completeHandshake(server.getPublicKey());

      // Simulate terminal output with ANSI escapes
      const terminalData = "\x1b[32mgreen text\x1b[0m\r\n$ ls -la\r\n";
      const enc = client.encryptMessage(terminalData);
      const dec = server.decryptMessage(enc);
      expect(dec).toBe(terminalData);
    });
  });
});
