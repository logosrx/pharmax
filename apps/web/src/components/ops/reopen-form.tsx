// ReopenForm — the shared "reopen for correction" control.
//
// Typing (PV1 bounce-back) and Fill (final-verification bounce-back)
// both reopen an order into a specific in-progress state with a reason
// code + optional note (required when reason = OTHER; the route
// enforces and PHI-redacts it from logs). One component so the two
// surfaces stay identical.

import { REOPEN_REASONS } from "@pharmax/orders";

import { Field, Select, Input } from "../ui/field.js";
import { ActionForm, SubmitButton } from "./action-form.js";

export function ReopenForm({
  orderId,
  reopenToState,
  defaultReason,
  submitLabel,
}: {
  readonly orderId: string;
  readonly reopenToState: string;
  readonly defaultReason: string;
  readonly submitLabel: string;
}) {
  return (
    <ActionForm
      action={`/api/ops/orders/${orderId}/reopen-for-correction`}
      className="grid w-full grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
    >
      <input type="hidden" name="reopenToState" value={reopenToState} />
      <Field label="Reason">
        <Select name="reason" defaultValue={defaultReason}>
          {REOPEN_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Note" help="Required when reason is OTHER · redacted from logs">
        <Input type="text" name="reasonText" maxLength={2000} placeholder="optional context" />
      </Field>
      <div className="flex items-end">
        <SubmitButton variant="secondary" icon="arrowRight" className="w-full sm:w-auto">
          {submitLabel}
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
