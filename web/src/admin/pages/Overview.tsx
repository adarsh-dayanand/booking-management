import { api } from "../api";
import { formatRupees } from "../../shared/format";
import { useAsync } from "../../shared/hooks";
import { Alert, Button, PageHeader, Spinner, Stat } from "../../shared/ui";
import type { Overview } from "../types";

export function OverviewPage({ go }: { go: (to: string) => void }) {
  const { data: o, error, loading } = useAsync(() => api.get<Overview>("/v1/admin/overview"));
  return (
    <>
      <PageHeader title="Platform overview" actions={<Button onClick={() => go("/consultants")}>Manage consultants</Button>} />
      <Alert>{error}</Alert>
      {loading && !o && <Spinner />}
      {o && (
        <div className="stats">
          <Stat label="Consultants" value={o.consultants} hint={`${o.paymentsEnabled} with payments enabled`} />
          <Stat label="Appointments, 30 days" value={o.appointments30d} />
          <Stat label="Users" value={o.users} hint="across all consultants" />
          <Stat label="Payments, 30 days" value={formatRupees(o.revenue30dPaise)} tone="good" hint="paid through Razorpay" />
        </div>
      )}
    </>
  );
}
