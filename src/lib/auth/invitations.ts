import { createHash, randomBytes, randomUUID } from "node:crypto";

export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function invitationHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Only the create command may disclose token. Never pass it to a logger. */
export function newInvitation(email: string, hours = 24) {
  email = canonicalEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      !Number.isInteger(hours) || hours < 1 || hours > 168) {
    throw new Error("Invalid invitation parameters");
  }
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    record: {
      id: randomUUID(), email, tokenHash: invitationHash(token),
      createdAt: new Date(), expiresAt: new Date(Date.now() + hours * 3_600_000),
      consumed: false, revoked: false,
    },
  };
}
