// /ops/shipping/[orderId]/rates — rate shopping before label purchase.
//
// Quote → pick → buy: quotes every purchasable service for the
// order's shipment (from-address, decrypted patient to-address,
// default parcel — same context the auto-purchase route resolves)
// and renders one Buy button per option. Buying posts the chosen
// serviceLevel to the existing purchase route, so the full command
// path (address validation, signature option, saga void-on-failure,
// audit) is identical to a direct purchase.
//
// Query params:
//   - provider: which credentialed provider to quote (default FEDEX
//     — the only adapter with getRates today).
//   - signatureOption: carried through to every Buy form so the
//     compliance choice survives the rate-shopping detour.
//
// PHI: this page renders rates only — no recipient address content.
// Quoting costs nothing and mutates nothing; refreshing re-quotes.

import Link from "next/link";

import { ShippingProvider } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { quoteShippingRates } from "../../../../../src/server/ops/quote-shipping-rates.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import {
  EmptyState,
  ErrorState,
  PermissionDenied,
} from "../../../../../src/components/ui/feedback.js";
import { buttonClass } from "../../../../../src/components/ui/button.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../../src/components/ui/data.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";

const SIGNATURE_OPTIONS = new Set(["NO_SIGNATURE_REQUIRED", "INDIRECT", "DIRECT", "ADULT"]);

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function ShippingRatesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly orderId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ orderId }, sp] = await Promise.all([params, searchParams]);

  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.SHIP_PURCHASE_LABEL)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Fulfillment" title="Shop rates" />
        <PermissionDenied grant="ship.purchase_label" role="Shipping Clerk" />
      </div>
    );
  }

  const providerParam = typeof sp["provider"] === "string" ? sp["provider"] : "FEDEX";
  const provider =
    providerParam === ShippingProvider.EASYPOST ||
    providerParam === ShippingProvider.UPS ||
    providerParam === ShippingProvider.FEDEX
      ? (providerParam as ShippingProvider)
      : ShippingProvider.FEDEX;
  const signatureOption =
    typeof sp["signatureOption"] === "string" && SIGNATURE_OPTIONS.has(sp["signatureOption"])
      ? sp["signatureOption"]
      : null;

  const result = await quoteShippingRates({
    organizationId: session.tenancy.organizationId,
    orderId,
    provider,
  });

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Fulfillment"
        title="Shop rates"
        description={`Live ${provider} quotes for this order's shipment. Buying uses the same validated purchase path as the queue.`}
        actions={
          <Link href="/ops/shipping" className={buttonClass({ variant: "secondary", size: "sm" })}>
            Back to shipping queue
          </Link>
        }
      />

      {!result.ok ? (
        <ErrorState
          title="Rate quoting failed"
          description={result.message}
          detail={result.code}
          retryHref={`/ops/shipping/${orderId}/rates?provider=${provider}${
            signatureOption !== null ? `&signatureOption=${signatureOption}` : ""
          }`}
          retryLabel="Re-quote rates"
        />
      ) : result.rates.length === 0 ? (
        <EmptyState
          icon="carriers"
          title="No services quoted for this lane"
          description="The carrier returned no purchasable services for this origin/destination/parcel — try another provider or re-quote later."
          action={{ label: "Back to shipping queue", href: "/ops/shipping" }}
          hint="Quoting costs nothing and mutates nothing; refreshing re-quotes."
        />
      ) : (
        <Section title="Available services" count={result.rates.length}>
          <p className="text-xs text-subtle">
            Account-negotiated rates for a{" "}
            {`${result.parcel.lengthInches}x${result.parcel.widthInches}x${result.parcel.heightInches}in, ${result.parcel.weightOunces}oz`}{" "}
            parcel · cheapest first
            {signatureOption !== null
              ? ` · signature: ${signatureOption.replaceAll("_", " ").toLowerCase()}`
              : ""}
          </p>
          <Table>
            <THead>
              <TR>
                <TH>Service</TH>
                <TH>Code</TH>
                <TH>Rate</TH>
                <TH> </TH>
              </TR>
            </THead>
            <TBody>
              {result.rates.map((rate) => (
                <TR key={rate.serviceLevel}>
                  <TD>{rate.serviceName ?? rate.serviceLevel}</TD>
                  <TD>
                    <code className="font-mono text-xs">{rate.serviceLevel}</code>
                  </TD>
                  <TD>
                    <span className="font-semibold tabular-nums">{formatUsd(rate.rateCents)}</span>
                  </TD>
                  <TD>
                    <ActionForm action={`/api/ops/orders/${orderId}/purchase-shipment-label`}>
                      <input type="hidden" name="provider" value={provider} />
                      <input type="hidden" name="carrier" value={rate.carrier} />
                      <input type="hidden" name="serviceLevel" value={rate.serviceLevel} />
                      {signatureOption !== null ? (
                        <input type="hidden" name="signatureOption" value={signatureOption} />
                      ) : null}
                      <SubmitButton icon="package">Buy {formatUsd(rate.rateCents)}</SubmitButton>
                    </ActionForm>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Section>
      )}
    </div>
  );
}
