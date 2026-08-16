#!/usr/bin/env tsx
// scripts/security/audit-carrier-base-urls.ts
//
// Retro-screen every STORED `carrier_credential.baseUrl` against the
// shared outbound-URL guard (`net.classifyOutboundUrl`, ADR-0032) and
// report the rows that fail.
//
// Why this exists
//
// `RegisterCarrierCredential` has screened `baseUrl` since c5dc430,
// but the column predates the guard and a write-time check does not
// clean a table it was added to. `resolveShippingAdapter` reads
// `baseUrl` back verbatim, and the FedEx/UPS tracking pollers rebuild
// a carrier client every tick — so a row written before the guard
// re-sends the decrypted credential to whatever host it names, on a
// loop, unattended. This tool finds those rows.
//
// WHY THIS TOOL DOES NOT DISABLE ANYTHING
//
// It reports, and exits non-zero. It never mutates a row. Three
// reasons, in increasing order of weight:
//
//   1. Disabling a carrier credential stops label purchase AND
//      tracking for that organization. In a pharmacy that is not an
//      SLA blip — prescriptions stop shipping. A false positive
//      would be an outage manufactured by a validation verdict.
//   2. `RegisterCarrierCredential` already establishes the invariant
//      to be consistent with: it screens the incoming baseUrl BEFORE
//      it disables the prior ACTIVE row, specifically so that a
//      refusal can never strand an organization with no working
//      credential. Auto-disabling stored rows does the exact thing
//      that handler is written to avoid, with no operator in the
//      loop and no replacement staged.
//   3. There is no `DisableCarrierCredential` command. Writing
//      `status = DISABLED` from a script would be an unaudited
//      mutation of a security-sensitive row — no command_log, no
//      audit_log, no event_outbox, no actor stamp — which is the
//      shape of write this repo forbids outright.
//
// And disabling would not even stop the harm it looks like it stops.
// The credential has already been transmitted to the offending
// destination on every poller tick since the row was written; it is
// burned. Rotating it at the carrier is what invalidates it.
// Disabling the Pharmax row only halts further re-sends — which
// re-registering with a correct baseUrl also does, without the
// outage. So the remediation this tool prescribes is rotate, then
// re-register through the command.
//
// ONE-SHOT AUDIT VS RECURRING GUARD
//
// The population this closes is historical and finite: the write path
// is screened, so no new offending row can be created through the
// command. Remediation is therefore a bounded task, which is why this
// is an operator script rather than a worker drain.
//
// It is also built to be run on a schedule, because the command is
// not the only way a row can appear — a restored backup, a direct DB
// fix, a seed, or a future second write path all bypass it. The tool
// is read-only, its scan is bounded by paging, and its exit code is
// clean (0 = clean, 1 = findings), so pointing cron or a CI job at it
// turns the same tool into the recurring guard.
//
// Output contract
//
//   stdout  Line-delimited JSON: one `{"kind":"finding",...}` object
//           per offending row, then one `{"kind":"summary",...}`.
//           Redirect it to a file or pipe it to jq.
//   stderr  The human narrative and the remediation steps.
//
// Exit codes:
//   0  No offending rows.
//   1  At least one offending row, or bad arguments.
//
// Usage:
//   pnpm security:audit-carrier-urls
//   pnpm security:audit-carrier-urls -- --org=<uuid>
//
// Required env:
//   DATABASE_URL   Postgres connection string.
//
// PHI: none — this script never reads the encrypted columns. It
// selects only ids, provider, status, baseUrl, and createdAt.
// CREDENTIALS: none in the output. `baseUrl` is reported REDACTED to
// scheme + host, because a row written before the guard can carry a
// credential in userinfo (that is what the `embedded_credentials`
// verdict is) and a path or query can carry a bearer token. Every
// line this tool prints is safe to paste into a ticket.

import { parseArgs } from "node:util";

import { prisma } from "@pharmax/database";
import {
  type CarrierBaseUrlFinding,
  type CarrierBaseUrlFindingSummary,
  screenStoredCarrierBaseUrl,
  type StoredCarrierCredentialRow,
  summarizeCarrierBaseUrlFindings,
} from "@pharmax/shipping";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage:
  pnpm security:audit-carrier-urls                 # every organization
  pnpm security:audit-carrier-urls -- --org=<uuid> # one organization

Required env:
  DATABASE_URL   Postgres connection string.
`.trim();

// ---------------------------------------------------------------------------
// Pure layer (exported for tests).
// ---------------------------------------------------------------------------

/** Screen a batch of rows, dropping the ones that pass. */
export function collectFindings(
  rows: ReadonlyArray<StoredCarrierCredentialRow>
): CarrierBaseUrlFinding[] {
  const findings: CarrierBaseUrlFinding[] = [];
  for (const row of rows) {
    const finding = screenStoredCarrierBaseUrl(row);
    if (finding !== null) {
      findings.push(finding);
    }
  }
  return findings;
}

/**
 * One finding as a single JSON line. The finding is already redacted
 * by `screenStoredCarrierBaseUrl`; this only frames it.
 */
export function findingLine(finding: CarrierBaseUrlFinding): string {
  return JSON.stringify({ kind: "finding", ...finding });
}

export function summaryLine(summary: CarrierBaseUrlFindingSummary): string {
  return JSON.stringify({ kind: "summary", ...summary });
}

/**
 * Findings are a failure: the exit code is what lets this run as a
 * scheduled guard without anyone reading the output.
 */
export function exitCodeForSummary(summary: CarrierBaseUrlFindingSummary): 0 | 1 {
  return summary.total > 0 ? 1 : 0;
}

/** Remediation, ordered. See the header for why disabling is absent. */
export function remediationNarrative(summary: CarrierBaseUrlFindingSummary): string {
  if (summary.total === 0) {
    return "No stored carrier base URL fails the outbound-URL guard.";
  }
  return [
    `${summary.total} stored carrier credential row(s) across ${summary.organizationsAffected} organization(s) name a destination the outbound-URL guard refuses.`,
    `${summary.dialledToday} of them are the ACTIVE row for their (organization, provider) pair, which means the credential is being re-sent to that destination on every tracking-poller tick right now.`,
    "",
    "Remediation, in this order:",
    "",
    "  1. ROTATE the credential at the carrier. Each finding means the",
    "     credential has already been transmitted to that destination,",
    "     repeatedly. Disabling the row in Pharmax does not un-send it;",
    "     rotation at the carrier is the only step that invalidates it.",
    "",
    "  2. RE-REGISTER via RegisterCarrierCredential with a correct",
    "     baseUrl, or omit baseUrl to use the carrier default. That",
    "     command screens the new value BEFORE it disables the prior",
    "     ACTIVE row, so the organization is never left without a",
    "     working credential, and it writes the full command_log /",
    "     audit_log / event_outbox chain.",
    "",
    "  3. Only if no replacement credential is available: decide to",
    "     accept a shipping outage for that organization. This tool",
    "     will not make that call for you.",
    "",
    "Every line on stdout is redacted to scheme + host and is safe to",
    "paste into a ticket.",
  ].join("\n");
}

interface ParsedCli {
  readonly organizationId?: string;
}

export function parseCli(argv: ReadonlyArray<string>): ParsedCli | { readonly error: string } {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== "--"),
    options: {
      org: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help === true) {
    return { error: USAGE };
  }

  return {
    ...(typeof values.org === "string" ? { organizationId: values.org } : {}),
  };
}

// ---------------------------------------------------------------------------
// Scan.
// ---------------------------------------------------------------------------

/** Bounded per-query page; the loop pages until exhaustion. */
const SCAN_PAGE_SIZE = 500;

interface ScanResult {
  readonly rowsScanned: number;
  readonly findings: ReadonlyArray<CarrierBaseUrlFinding>;
}

async function scan(organizationId: string | undefined): Promise<ScanResult> {
  // System context: this is a cross-tenant security sweep, so the
  // tenancy extension has to pass the query through unfiltered. The
  // reason string is what shows up if this ever needs explaining.
  return withSystemContext("scripts:audit-carrier-base-urls", async () => {
    const findings: CarrierBaseUrlFinding[] = [];
    let rowsScanned = 0;
    let cursor: string | undefined;

    for (;;) {
      const page = await prisma.carrierCredential.findMany({
        // DISABLED rows are screened too: their credential was
        // exposed just as much and still needs rotating. The
        // `dialledToday` flag on each finding is what separates
        // "leaking now" from "already leaked".
        where: organizationId !== undefined ? { organizationId } : {},
        // Encrypted columns are deliberately NOT selected. Key
        // material must not be in scope for a reporting path.
        select: {
          id: true,
          organizationId: true,
          provider: true,
          status: true,
          baseUrl: true,
          createdAt: true,
        },
        orderBy: { id: "asc" },
        take: SCAN_PAGE_SIZE,
        ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      rowsScanned += page.length;
      findings.push(...collectFindings(page));

      if (page.length < SCAN_PAGE_SIZE) {
        return { rowsScanned, findings };
      }
      cursor = page[page.length - 1]!.id;
    }
  });
}

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 1;
    return;
  }

  const scope =
    parsed.organizationId !== undefined
      ? `organization ${parsed.organizationId}`
      : "every organization";
  process.stderr.write(`Screening stored carrier base URLs for ${scope}…\n`);

  const { rowsScanned, findings } = await scan(parsed.organizationId);
  const summary = summarizeCarrierBaseUrlFindings(findings);

  for (const finding of findings) {
    process.stdout.write(`${findingLine(finding)}\n`);
  }
  process.stdout.write(`${summaryLine(summary)}\n`);

  process.stderr.write(`\nScanned ${rowsScanned} carrier credential row(s).\n`);
  process.stderr.write(`${remediationNarrative(summary)}\n`);

  process.exitCode = exitCodeForSummary(summary);
}

// Only execute when run as a CLI (tests import the pure helpers).
const isDirectRun = process.argv[1]?.includes("audit-carrier-base-urls") ?? false;
if (isDirectRun) {
  main()
    .catch((cause: unknown) => {
      process.stderr.write(
        `${JSON.stringify({
          kind: "error",
          error: cause instanceof Error ? cause.message : "unknown",
        })}\n`
      );
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
