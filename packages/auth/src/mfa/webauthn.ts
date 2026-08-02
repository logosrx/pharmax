// WebAuthn adapter port (ADR-0036, slice 1).
//
// The engine does NOT implement CBOR/COSE/attestation parsing — the
// same "compose primitives, don't reinvent them" rule ADR-0030 applied
// to Argon2id and TOTP. This file defines the port the commands program
// against, plus the production adapter wrapping @simplewebauthn/server.
// Tests inject a deterministic fake adapter.
//
// Design notes:
//   - Attestation type is "none": we take no stance on authenticator
//     provenance, only on possession (the password is always the first
//     factor). AAGUID is stored when present for inventory/forensics.
//   - User verification is "preferred", enforced as second-factor
//     presence, not PIN-mandatory (`requireUserVerification: false` at
//     verify time) — NIST AAL2 posture for a 2FA flow.
//   - All ids/keys cross the port as base64url strings; the adapter
//     owns the byte-level conversions.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/** Ceremony options as JSON, passed verbatim to the browser API. */
export type WebAuthnOptionsJSON = Record<string, unknown>;

export interface GenerateWebAuthnRegistrationInput {
  readonly rpId: string;
  readonly rpName: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly userDisplayName: string;
  /** Already-registered credential ids (base64url) to exclude. */
  readonly excludeCredentialIds: ReadonlyArray<string>;
}

export interface GeneratedWebAuthnOptions {
  /** Base64url challenge embedded in the options — persisted server-side. */
  readonly challenge: string;
  readonly optionsJSON: WebAuthnOptionsJSON;
}

export type WebAuthnRegistrationResult =
  | { readonly verified: false }
  | {
      readonly verified: true;
      /** Base64url credential id. */
      readonly credentialId: string;
      /** Base64url COSE public key. */
      readonly publicKey: string;
      readonly counter: bigint;
      readonly transports: ReadonlyArray<string>;
      readonly aaguid: string | null;
    };

export interface VerifyWebAuthnRegistrationInput {
  /** The browser's `startRegistration()` response (untrusted JSON). */
  readonly response: unknown;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string;
  readonly expectedRpId: string;
}

export interface GenerateWebAuthnAuthenticationInput {
  readonly rpId: string;
  /** The user's active credential ids (base64url) with their transports. */
  readonly allowCredentials: ReadonlyArray<{
    readonly credentialId: string;
    readonly transports: ReadonlyArray<string>;
  }>;
}

export type WebAuthnAuthenticationResult =
  { readonly verified: false } | { readonly verified: true; readonly newCounter: bigint };

export interface VerifyWebAuthnAuthenticationInput {
  /** The browser's `startAuthentication()` response (untrusted JSON). */
  readonly response: unknown;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string;
  readonly expectedRpId: string;
  readonly credential: {
    /** Base64url credential id. */
    readonly credentialId: string;
    /** Base64url COSE public key. */
    readonly publicKey: string;
    readonly counter: bigint;
    readonly transports: ReadonlyArray<string>;
  };
}

export interface WebAuthnAdapter {
  generateRegistrationOptions(
    input: GenerateWebAuthnRegistrationInput
  ): Promise<GeneratedWebAuthnOptions>;
  verifyRegistration(input: VerifyWebAuthnRegistrationInput): Promise<WebAuthnRegistrationResult>;
  generateAuthenticationOptions(
    input: GenerateWebAuthnAuthenticationInput
  ): Promise<GeneratedWebAuthnOptions>;
  verifyAuthentication(
    input: VerifyWebAuthnAuthenticationInput
  ): Promise<WebAuthnAuthenticationResult>;
}

/** Production adapter over @simplewebauthn/server. */
export function createSimpleWebAuthnAdapter(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) {
      const options = await generateRegistrationOptions({
        rpID: input.rpId,
        rpName: input.rpName,
        userID: new TextEncoder().encode(input.userId),
        userName: input.userEmail,
        userDisplayName: input.userDisplayName,
        attestationType: "none",
        excludeCredentials: input.excludeCredentialIds.map((id) => ({ id })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
      return {
        challenge: options.challenge,
        optionsJSON: options as unknown as WebAuthnOptionsJSON,
      };
    },

    async verifyRegistration(input) {
      try {
        const verification = await verifyRegistrationResponse({
          response: input.response as RegistrationResponseJSON,
          expectedChallenge: input.expectedChallenge,
          expectedOrigin: input.expectedOrigin,
          expectedRPID: input.expectedRpId,
          // Second-factor flow: presence is required, PIN/biometric is not.
          requireUserVerification: false,
        });
        if (!verification.verified) {
          return { verified: false };
        }
        const { credential, aaguid } = verification.registrationInfo;
        return {
          verified: true,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: BigInt(credential.counter),
          transports: credential.transports ?? [],
          aaguid: aaguid.length > 0 ? aaguid : null,
        };
      } catch {
        // Malformed/forged attestations throw inside the library —
        // normalize to a typed rejection; never leak parse internals.
        return { verified: false };
      }
    },

    async generateAuthenticationOptions(input) {
      const options = await generateAuthenticationOptions({
        rpID: input.rpId,
        allowCredentials: input.allowCredentials.map((c) => ({
          id: c.credentialId,
          transports: c.transports as AuthenticatorTransportFuture[],
        })),
        userVerification: "preferred",
      });
      return {
        challenge: options.challenge,
        optionsJSON: options as unknown as WebAuthnOptionsJSON,
      };
    },

    async verifyAuthentication(input) {
      try {
        const verification = await verifyAuthenticationResponse({
          response: input.response as AuthenticationResponseJSON,
          expectedChallenge: input.expectedChallenge,
          expectedOrigin: input.expectedOrigin,
          expectedRPID: input.expectedRpId,
          credential: {
            id: input.credential.credentialId,
            publicKey: new Uint8Array(Buffer.from(input.credential.publicKey, "base64url")),
            counter: Number(input.credential.counter),
            transports: input.credential.transports as AuthenticatorTransportFuture[],
          },
          requireUserVerification: false,
        });
        if (!verification.verified) {
          return { verified: false };
        }
        return {
          verified: true,
          newCounter: BigInt(verification.authenticationInfo.newCounter),
        };
      } catch {
        return { verified: false };
      }
    },
  };
}
