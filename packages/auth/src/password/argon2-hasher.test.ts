import { describe, expect, it } from "vitest";

import { createArgon2idHasher } from "./argon2-hasher.js";

describe("createArgon2idHasher — hash/verify", () => {
  it("produces an argon2id PHC hash and verifies the correct password", async () => {
    const hasher = createArgon2idHasher({});
    const hash = await hasher.hash("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await hasher.verify(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects the wrong password (returns false, does not throw)", async () => {
    const hasher = createArgon2idHasher({});
    const hash = await hasher.hash("the right password");
    expect(await hasher.verify(hash, "the wrong password")).toBe(false);
  });

  it("returns false for a malformed/foreign hash string", async () => {
    const hasher = createArgon2idHasher({});
    expect(await hasher.verify("not-a-real-hash", "whatever")).toBe(false);
  });
});

describe("createArgon2idHasher — pepper", () => {
  it("a hash made WITH a pepper does not verify WITHOUT it", async () => {
    const pepper = new Uint8Array(32).fill(7);
    const peppered = createArgon2idHasher({ pepper });
    const plain = createArgon2idHasher({ pepper: null });

    const hash = await peppered.hash("shared-plaintext-123");
    expect(await peppered.verify(hash, "shared-plaintext-123")).toBe(true);
    // Without the pepper the same plaintext fails to verify — the DB-only
    // breach defense.
    expect(await plain.verify(hash, "shared-plaintext-123")).toBe(false);
  });
});

describe("createArgon2idHasher — needsRehash", () => {
  it("does not rehash a hash produced at current params", async () => {
    const hasher = createArgon2idHasher({});
    const hash = await hasher.hash("current-params-password");
    expect(hasher.needsRehash(hash)).toBe(false);
  });

  it("rehashes a hash produced with weaker parameters", () => {
    const hasher = createArgon2idHasher({});
    // A well-formed argon2id PHC string with below-policy memory cost.
    const weak = "$argon2id$v=19$m=1024,t=1,p=1$c29tZXNhbHQ$c29tZWhhc2g";
    expect(hasher.needsRehash(weak)).toBe(true);
  });

  it("rehashes a non-argon2id hash", () => {
    const hasher = createArgon2idHasher({});
    expect(hasher.needsRehash("$argon2i$v=19$m=19456,t=2,p=1$x$y")).toBe(true);
    expect(hasher.needsRehash("plain")).toBe(true);
  });
});
