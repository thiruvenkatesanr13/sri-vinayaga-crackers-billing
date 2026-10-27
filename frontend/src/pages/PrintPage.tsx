import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Printer } from "lucide-react";
import { api, errorText } from "../lib/api";
import type { Bill } from "../lib/types";
import { Button, Loading, Notice, useToast } from "../components/ui";
import Receipt from "../components/Receipt";
import WhatsAppBillButton from "../components/WhatsAppBillButton";

/** Full-page receipt for reprinting an old bill. */
export default function PrintPage() {
  const { id } = useParams();
  const notify = useToast();
  const [printing, setPrinting] = useState(false);
  const [duplicate, setDuplicate] = useState<boolean | null>(null);
  const bill = useQuery({ queryKey: ["bill", Number(id)], queryFn: () => api.get<Bill>(`/api/bills/${id}`) });

  async function print() {
    if (!bill.data) return;
    setPrinting(true);
    try {
      const result = await api.post<{ duplicate: boolean }>(`/api/bills/${bill.data.id}/printed`);
      setDuplicate(result.duplicate);
      window.setTimeout(() => {
        window.print();
        setPrinting(false);
      }, 60);
    } catch (error) {
      notify(errorText(error), "bad");
      setPrinting(false);
    }
  }

  return (
    <div className="print-page">
      <div className="print-tools no-print">
        <Link className="btn" to="/bills">
          <ArrowLeft size={16} aria-hidden /> Bills
        </Link>
        {bill.data ? (
          <Button variant="primary" onClick={print} loading={printing}>
            <Printer size={16} aria-hidden /> Print
          </Button>
        ) : null}
        {bill.data ? <WhatsAppBillButton bill={bill.data} /> : null}
      </div>
      {bill.isPending ? <Loading /> : null}
      {bill.isError ? (
        <div className="no-print" style={{ maxWidth: 480, margin: "0 auto" }}>
          <Notice tone="bad">{errorText(bill.error)}</Notice>
        </div>
      ) : null}
      {bill.data ? <Receipt bill={bill.data} duplicate={duplicate ?? bill.data.print_count >= 1} /> : null}
    </div>
  );
}
