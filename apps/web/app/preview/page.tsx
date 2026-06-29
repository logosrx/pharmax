// /preview — design-system showcase (PUBLIC, no auth, no DB).
//
// A self-contained visual reference for the Pharmax operator console
// UI: the application shell, dashboard patterns, workflow queue rows,
// and the full primitive library rendered with synthetic data. This
// is for human visual review only — it never touches the database,
// tenancy, or any command path. Allowlisted in proxy.ts.

import { SidebarNav, type NavGroup } from "../../src/components/shell/sidebar-nav.js";
import { OrderSearch } from "../../src/components/shell/order-search.js";
import { ThemeToggle } from "../../src/components/shell/theme-toggle.js";
import { PageHeader, Section, FilterTabs } from "../../src/components/ui/page.js";
import { Stat, Table, THead, TH, TBody, TR, TD, DataList } from "../../src/components/ui/data.js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  LinkCard,
} from "../../src/components/ui/card.js";
import { Badge, Dot, Kbd, type Tone } from "../../src/components/ui/badge.js";
import { Button, buttonClass } from "../../src/components/ui/button.js";
import { Banner, EmptyState } from "../../src/components/ui/feedback.js";
import { Field, Input, Select, Textarea } from "../../src/components/ui/field.js";
import { Icon } from "../../src/components/ui/icon.js";
import { QueueRow } from "../../src/components/ops/queue-row.js";
import { StageTimeline } from "../../src/components/ops/stage-timeline.js";

const NAV: ReadonlyArray<NavGroup> = [
  {
    label: "Workflow",
    items: [
      { href: "/preview", label: "Dashboard", icon: "dashboard" },
      { href: "/preview#typing", label: "Typing", icon: "typing", count: 12 },
      { href: "/preview#pv1", label: "PV1 verification", icon: "verify", count: 5 },
      { href: "/preview#fill", label: "Fill", icon: "fill", count: 8 },
      { href: "/preview#final", label: "Final verification", icon: "final", count: 3 },
    ],
  },
  {
    label: "Fulfillment",
    items: [
      { href: "/preview#shipping", label: "Shipping", icon: "shipping", count: 6 },
      { href: "/preview#dock", label: "Dock capture", icon: "dock" },
      { href: "/preview#unmatched", label: "Unmatched photos", icon: "unmatched", count: 2 },
      { href: "/preview#emergency", label: "Emergency", icon: "emergency", count: 1 },
    ],
  },
  {
    label: "Finance",
    items: [
      { href: "/preview#billing", label: "Billing", icon: "billing" },
      { href: "/preview#reports", label: "Reports", icon: "reports" },
      { href: "/preview#history", label: "Report history", icon: "history" },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/preview#users", label: "Users", icon: "users" },
      { href: "/preview#patients", label: "Patients", icon: "patients" },
      { href: "/preview#sites", label: "Sites", icon: "sites" },
    ],
  },
];

const TONES: ReadonlyArray<Tone> = [
  "neutral",
  "brand",
  "success",
  "warning",
  "danger",
  "info",
  "violet",
  "cyan",
];

export default function PreviewPage() {
  const now = new Date();
  const mins = (m: number) => new Date(now.getTime() + m * 60_000);

  return (
    <div className="flex min-h-screen bg-canvas text-fg">
      <SidebarNav groups={NAV} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas/80 px-4 backdrop-blur-md sm:px-6">
          <OrderSearch />
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right leading-tight sm:block">
              <div className="text-sm font-medium text-fg">Jordan Pharmacist</div>
              <div className="text-[11px] text-subtle">jordan@northgate.rx</div>
            </div>
            <ThemeToggle />
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-semibold text-brand-fg">
              JP
            </span>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 space-y-10 px-4 py-6 sm:px-6 lg:px-8">
          <Banner tone="info" title="Design-system preview">
            This is a static showcase with synthetic data — no database, no auth. Toggle light/dark
            (top-right), collapse the sidebar, and press <Kbd>/</Kbd> to focus search.
          </Banner>

          {/* ---- Dashboard pattern ---- */}
          <PageHeader
            eyebrow="Thursday, June 4"
            title="Good afternoon, Jordan"
            description="Your pharmacy at a glance — live queue depth, exceptions, and the fastest path into your work."
            actions={
              <button type="button" className={buttonClass({ variant: "primary" })}>
                <Icon name="typing" size={16} />
                Go to Typing
              </button>
            }
          />

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat
              label="In-flight orders"
              value={34}
              icon="package"
              tone="brand"
              hint="Across all active stages"
            />
            <Stat
              label="Awaiting verification"
              value={8}
              icon="verify"
              tone="info"
              hint="PV1 + final review"
            />
            <Stat
              label="Ready to type"
              value={12}
              icon="typing"
              tone="warning"
              hint="Inbox waiting"
            />
            <Stat
              label="Emergency"
              value={1}
              icon="emergency"
              tone="danger"
              hint="Escalated orders"
            />
          </div>

          <Section title="Workflow pipeline" aside="Live queue depth, in flow order">
            <Card>
              <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-stretch sm:gap-0">
                {(
                  [
                    { label: "Typing", icon: "typing", n: 12 },
                    { label: "PV1", icon: "verify", n: 5 },
                    { label: "Fill", icon: "fill", n: 8 },
                    { label: "Final", icon: "final", n: 3 },
                    { label: "Shipping", icon: "shipping", n: 6 },
                  ] as const
                ).map((s, i, arr) => (
                  <div key={s.label} className="flex flex-1 items-center">
                    <div className="flex flex-1 items-center gap-3 rounded-lg px-4 py-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-brand/30 bg-brand/10 text-brand">
                        <Icon name={s.icon} size={18} />
                      </span>
                      <div>
                        <div className="text-2xl font-semibold tabular-nums text-fg">{s.n}</div>
                        <div className="text-xs text-muted">{s.label}</div>
                      </div>
                    </div>
                    {i < arr.length - 1 ? (
                      <Icon name="chevronRight" size={16} className="hidden text-subtle sm:block" />
                    ) : null}
                  </div>
                ))}
              </div>
            </Card>
          </Section>

          {/* ---- Queue rows ---- */}
          <Section
            title="Workflow queue rows"
            count={3}
            aside="SLA accent rail · priority · status"
          >
            <ul className="space-y-3">
              <li>
                <QueueRow
                  orderId="ord_1"
                  externalOrderNumber="ORD-2026-004821"
                  priority="EMERGENCY"
                  status="PV1_IN_PROGRESS"
                  slaDeadlineAt={mins(-22)}
                  receivedAt={mins(-140)}
                  now={now}
                >
                  <Button variant="go" icon="check" size="sm">
                    Approve PV1
                  </Button>
                  <Button variant="danger" icon="x" size="sm">
                    Reject
                  </Button>
                </QueueRow>
              </li>
              <li>
                <QueueRow
                  orderId="ord_2"
                  externalOrderNumber="ORD-2026-004822"
                  priority="RUSH"
                  status="TYPED_READY_FOR_PV1"
                  slaDeadlineAt={mins(18)}
                  receivedAt={mins(-46)}
                  now={now}
                >
                  <Button icon="verify" size="sm">
                    Claim · Start PV1
                  </Button>
                </QueueRow>
              </li>
              <li>
                <QueueRow
                  orderId="ord_3"
                  externalOrderNumber="ORD-2026-004823"
                  priority="ROUTINE"
                  status="TYPING_PENDING_MISSING_INFO"
                  slaDeadlineAt={mins(180)}
                  receivedAt={mins(-12)}
                  now={now}
                  assigneeUserId="usr_alex"
                  note="Pending missing info. Resolve the gap (patient, prescriber, or sig) and resume typing."
                >
                  <Button variant="secondary" icon="typing" size="sm">
                    Resume typing
                  </Button>
                </QueueRow>
              </li>
            </ul>
          </Section>

          {/* ---- LinkCards ---- */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Section title="Clickable list cards (LinkCard)">
              <div className="space-y-2">
                <LinkCard
                  href="/preview"
                  end={
                    <div className="space-y-0.5">
                      <div className="font-mono text-base font-semibold tabular-nums text-fg">
                        USD 248.00
                      </div>
                      <div className="text-xs text-subtle">Due USD 248.00</div>
                    </div>
                  }
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium text-fg">INV-2026-0142</span>
                    <Badge tone="info">OPEN</Badge>
                  </div>
                  <div className="mt-1 text-xs text-subtle">3 lines · due 2026-06-18</div>
                </LinkCard>
                <LinkCard href="/preview" icon="reports" end={<Badge tone="neutral">v3</Badge>}>
                  <h3 className="text-sm font-semibold text-fg">Order volume by clinic</h3>
                  <p className="mt-0.5 text-sm text-muted">
                    Daily counts segmented by clinic + stage.
                  </p>
                  <code className="text-[11px] text-subtle">orders.volume_by_clinic</code>
                </LinkCard>
                <LinkCard href="/preview" icon="fill">
                  <div className="text-sm font-medium text-fg">Fill queue</div>
                  <div className="text-xs text-muted">8 orders waiting</div>
                </LinkCard>
              </div>
            </Section>

            <Section title="Record card + stage timeline">
              <Card>
                <CardHeader>
                  <CardTitle>Order ORD-2026-004821</CardTitle>
                  <Badge tone="info" dot>
                    PV1 in progress
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-5">
                  <StageTimeline status="PV1_IN_PROGRESS" />
                  <DataList
                    columns={2}
                    items={[
                      { label: "Patient", value: "Synthetic, Pat A." },
                      { label: "Date of birth", value: "1984-02-11" },
                      { label: "Prescriber", value: "Dr. Demo, NPI 1234567890" },
                      { label: "Drug", value: "Atorvastatin 20mg" },
                    ]}
                  />
                </CardContent>
              </Card>
            </Section>
          </div>

          {/* ---- Primitives gallery ---- */}
          <Section title="Buttons">
            <Card>
              <CardContent className="flex flex-wrap items-center gap-2">
                <Button variant="primary" icon="plus">
                  Primary
                </Button>
                <Button variant="go" icon="check">
                  Go / approve
                </Button>
                <Button variant="danger" icon="x">
                  Danger
                </Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="subtle">Subtle</Button>
                <Button variant="primary" size="sm">
                  Small
                </Button>
                <Button variant="secondary" size="lg">
                  Large
                </Button>
                <Button variant="secondary" size="icon" icon="settings" aria-label="Settings">
                  {""}
                </Button>
              </CardContent>
            </Card>
          </Section>

          <Section title="Badges, dots & keys">
            <Card>
              <CardContent className="flex flex-wrap items-center gap-2">
                {TONES.map((t) => (
                  <Badge key={t} tone={t} dot>
                    {t}
                  </Badge>
                ))}
                <span className="mx-2 inline-flex items-center gap-2 text-sm text-muted">
                  <Dot tone="success" pulse /> live
                </span>
                <Kbd>/</Kbd>
                <Kbd>⌘K</Kbd>
              </CardContent>
            </Card>
          </Section>

          <Section title="Banners">
            <div className="space-y-3">
              <Banner tone="success" title="Approved PV1">
                Order moved to the fill bucket.
              </Banner>
              <Banner tone="warning" title="SLA warning">
                3 orders are approaching their deadline.
              </Banner>
              <Banner tone="danger" title="That action didn't go through">
                The lot you selected is expired and cannot be assigned.
              </Banner>
              <Banner tone="info">
                Patient identity is decrypted and the view is audit-logged.
              </Banner>
            </div>
          </Section>

          <Section title="Filters + form controls">
            <div className="space-y-4">
              <FilterTabs
                items={[
                  { href: "/preview", label: "All", active: true },
                  { href: "/preview", label: "Open", active: false },
                  { href: "/preview", label: "Paid", active: false },
                  { href: "/preview", label: "Void", active: false },
                ]}
              />
              <Card>
                <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Carrier" help="Required by some carriers">
                    <Select defaultValue="USPS">
                      <option>USPS</option>
                      <option>UPS</option>
                      <option>FEDEX</option>
                    </Select>
                  </Field>
                  <Field label="Tracking number" required>
                    <Input placeholder="9400 1112 0250 9999 9999 99" className="font-mono" />
                  </Field>
                  <Field label="Operator note" className="sm:col-span-2">
                    <Textarea rows={2} placeholder="Optional context…" />
                  </Field>
                </CardContent>
              </Card>
            </div>
          </Section>

          <Section title="Table">
            <Table>
              <THead>
                <TH>Report</TH>
                <TH>Source</TH>
                <TH align="right">Rows</TH>
                <TH align="right">CSV</TH>
              </THead>
              <TBody>
                <TR>
                  <TD>
                    <div className="font-medium text-fg">Order volume by clinic</div>
                    <code className="text-xs text-subtle">orders.volume_by_clinic</code>
                  </TD>
                  <TD>
                    <Badge tone="violet">schedule</Badge>
                  </TD>
                  <TD align="right">1,284</TD>
                  <TD align="right">
                    <span className={buttonClass({ variant: "go", size: "sm" })}>
                      <Icon name="arrowRight" size={13} />
                      Download
                    </span>
                  </TD>
                </TR>
                <TR>
                  <TD>
                    <div className="font-medium text-fg">SLA breaches</div>
                    <code className="text-xs text-subtle">sla.breaches</code>
                  </TD>
                  <TD>
                    <Badge tone="neutral">operator</Badge>
                  </TD>
                  <TD align="right">42</TD>
                  <TD align="right">
                    <Badge tone="neutral">Not archived</Badge>
                  </TD>
                </TR>
              </TBody>
            </Table>
          </Section>

          <Section title="Empty state">
            <EmptyState
              icon="check"
              title="Nothing on fire"
              description="No orders are currently escalated. SLA breaches and shipping exceptions surface here."
              action={
                <button type="button" className={buttonClass({ variant: "secondary", size: "sm" })}>
                  View all
                </button>
              }
            />
          </Section>

          <footer className="border-t border-line pt-6 text-center text-xs text-subtle">
            Pharmax design system · iris brand · light/dark token-driven · synthetic data only
          </footer>
        </main>
      </div>
    </div>
  );
}
