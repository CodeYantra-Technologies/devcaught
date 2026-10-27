import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, formCsrfMiddleware } from "better-auth/api";
import { getCurrentAdapter, getCurrentDBAdapterAsyncLocalStorage, runWithTransaction } from "@better-auth/core/context";
import { z } from "zod";
import { canonicalEmail, invitationHash } from "./invitations.ts";
import { newPrivateInboxId } from "./private-inbox.ts";

const denied = () => new APIError("UNPROCESSABLE_ENTITY", { message: "Registration could not be completed" });

/** No endpoint before/after hook is used to claim an invitation. */
export function invitationPlugin(): BetterAuthPlugin {
  return {
    id: "devcaught-invitations",
    schema: {
      privateInbox: {
        modelName: "private_inbox",
        fields: {
          ownerId: {
            type: "string", required: true, unique: true, fieldName: "owner_id",
            references: { model: "user", field: "id", onDelete: "restrict" },
          },
          createdAt: { type: "date", required: true, fieldName: "created_at" },
        },
      },
      invitation: {
        modelName: "invitation",
        fields: {
          email: { type: "string", required: true },
          tokenHash: { type: "string", required: true, unique: true },
          createdAt: { type: "date", required: true },
          expiresAt: { type: "date", required: true },
          consumed: { type: "boolean", required: true },
          revoked: { type: "boolean", required: true },
          consumedAt: { type: "date", required: false },
        },
      },
    },
    endpoints: {
      registerInvitation: createAuthEndpoint("/register-invitation", {
        method: "POST",
        use: [formCsrfMiddleware],
        body: z.object({
          name: z.string().trim().min(1).max(120),
          email: z.string().trim().email().max(254),
          password: z.string().min(12).max(128),
          invitationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        }),
      }, async ctx => {
        // Hash before acquiring a database connection. Registration never issues
        // a session; login occurs only after this transaction has committed.
        const password = await ctx.context.password.hash(ctx.body.password);
        const email = canonicalEmail(ctx.body.email);
        try {
          await runWithTransaction(ctx.context.adapter, async () => {
            const state = (await getCurrentDBAdapterAsyncLocalStorage()).getStore();
            if (!state?.isTransactionActive) throw denied();
            const adapter = await getCurrentAdapter(ctx.context.adapter);
            const claimed = await adapter.update({
              model: "invitation",
              where: [
                { field: "tokenHash", value: invitationHash(ctx.body.invitationToken) },
                { field: "email", value: email },
                { field: "consumed", value: false },
                { field: "revoked", value: false },
                { field: "expiresAt", operator: "gt", value: new Date() },
              ],
              update: { consumed: true, consumedAt: new Date() },
            });
            if (!claimed) throw denied();
            const user = await ctx.context.internalAdapter.createUser({
              email, name: ctx.body.name, emailVerified: false,
            });
            if (!user) throw denied();
            await adapter.create({
              model: "privateInbox",
              data: { id: newPrivateInboxId(), ownerId: user.id, createdAt: new Date() },
              forceAllowId: true,
            });
            await ctx.context.internalAdapter.linkAccount({
              userId: user.id, accountId: user.id, providerId: "credential", password,
            });
          });
        } catch { throw denied(); }
        return ctx.json({ ok: true });
      }),
    },
  };
}

/** Shared by the single runtime instance and isolated test instances. */
export const invitationAuthPolicy = {
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128 },
  session: { cookieCache: { enabled: false } },
  // Database-backed limits span workers. No forwarded IP is trusted until an
  // operator approves a proxy boundary; all clients share per-path buckets.
  rateLimit: {
    enabled: true, storage: "database", window: 60, max: 120,
    customRules: {
      "/register-invitation": { window: 60, max: 10 },
      "/sign-in/email": { window: 60, max: 20 },
      "/sign-out": { window: 60, max: 30 },
    },
  },
  logger: { disabled: true },
} satisfies BetterAuthOptions;
