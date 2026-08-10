// SetThemePreference — save the operator's own console theme.
//
// Self-service (no RBAC gate — like ConfirmMfa, every operator manages
// their own account surface); the target row is always the actor's own
// user row. Cosmetic only: no workflow state, no queue, no order rows.
// Runs through the bus anyway so the change lands in command_log +
// audit_log like every other account mutation.
//
// PHI: none.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { UserThemePreference } from "@pharmax/database";
import { z } from "zod";

const inputSchema = z
  .object({
    theme: z.nativeEnum(UserThemePreference),
  })
  .strict();

export type SetThemePreferenceInput = z.infer<typeof inputSchema>;

export interface SetThemePreferenceOutput {
  readonly theme: UserThemePreference;
}

export const SetThemePreference: Command<SetThemePreferenceInput, SetThemePreferenceOutput> = {
  name: "SetThemePreference",
  inputSchema,
  permission: null,

  async handle({ input, ctx, tx, commandLogId }): Promise<HandlerResult<SetThemePreferenceOutput>> {
    const userId = ctx.actor.userId;

    await tx.user.update({
      where: { id: userId },
      data: { themePreference: input.theme },
    });

    return {
      output: Object.freeze({ theme: input.theme }),
      audit: {
        action: "user.theme_preference.changed",
        resourceType: "User",
        resourceId: userId,
        metadata: { userId, theme: input.theme, commandLogId },
      },
      outboxEvents: [],
    };
  },
};
