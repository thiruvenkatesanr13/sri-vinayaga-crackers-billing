import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Printer } from "lucide-react";
import { api, errorText } from "./api";
import { brand } from "./brand";
import type { Bill } from "./types";
import Receipt from "../components/Receipt";
import { Button, Dialog, useToast } from "../components/ui";

type Job = { bill: Bill; duplicate: boolean; onScreen: boolean };
let startJob: ((job: Job) => void) | null = null;

// Prints made from this screen, so a bill shown again after printing is marked DUPLICATE.
const printCounts = new Map<number, number>();

/** Each laptop either prints bills, or (with no bill printer) shows them on screen. */
export type BillOutput = "print" | "screen";
const OUTPUT_KEY = "svc.bill-output";
const outputListeners = new Set<() => void>();

function readOutput(): BillOutput {
  try {
    return window.localStorage.getItem(OUTPUT_KEY) === "screen" ? "screen" : "print";
  } catch {
    return "print";
  }
}

let output = readOutput();

export function setBillOutput(value: BillOutput) {
  output = value;
  try {
    window.localStorage.setItem(OUTPUT_KEY, value);
  } catch {
    // Storage is blocked: the choice lasts until the page is reloaded.
  }
  outputListeners.forEach((listener) => listener());
}

export function useBillOutput(): BillOutput {
  return useSyncExternalStore(
    (listener) => {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },
    () => output,
  );
}

// The receipt logo is loaded once, so even the first bill after opening the app prints with it.
let logoLoad: Promise<void> | null = null;
function receiptLogoReady(): Promise<void> {
  if (!logoLoad) {
    const image = new Image();
    image.src = brand.receipt;
    logoLoad = image.decode().catch(() => undefined);
  }
  // Never hold up a bill for the logo.
  return Promise.race([logoLoad, new Promise<void>((resolve) => window.setTimeout(resolve, 1500))]);
}

/** Prints bills: the receipt is rendered outside the app only while printing.
 *  Chrome started with --kiosk-printing prints straight to the default (80 mm) printer.
 *  On a laptop set to show bills on screen, the receipt opens in a window instead. */
export function PrintHost() {
  const [job, setJob] = useState<Job | null>(null);
  const [printing, setPrinting] = useState(false);
  const notify = useToast();
  const close = useCallback(() => setJob(null), []);

  useEffect(() => {
    startJob = setJob;
    void receiptLogoReady();
    return () => {
      startJob = null;
    };
  }, []);

  useEffect(() => {
    if (!job || job.onScreen) return;
    document.body.classList.add("print-host-active");
    let cancelled = false;
    const finish = () => {
      document.body.classList.remove("print-host-active");
      setJob(null);
    };
    window.addEventListener("afterprint", finish, { once: true });
    const timer = window.setTimeout(() => {
      void receiptLogoReady().then(() => {
        if (!cancelled) window.print();
      });
    }, 60);
    const safety = window.setTimeout(finish, 120_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearTimeout(safety);
      window.removeEventListener("afterprint", finish);
      document.body.classList.remove("print-host-active");
    };
  }, [job]);

  if (!job) return null;
  if (job.onScreen) {
    const bill = job.bill;
    return (
      <Dialog
        open
        title={`Bill ${bill.number}`}
        onClose={close}
        footer={
          <>
            <Button onClick={close}>Close</Button>
            <Button
              variant="primary"
              loading={printing}
              onClick={() => {
                setPrinting(true);
                printBill(bill, { onScreen: false })
                  .catch((error) => notify(errorText(error), "bad"))
                  .finally(() => setPrinting(false));
              }}
            >
              <Printer size={16} aria-hidden /> Print
            </Button>
          </>
        }
      >
        <div className="stack">
          <p className="muted small">
            This laptop shows bills on screen. To print them instead, press the counter button at the bottom of the menu and choose Print bills.
          </p>
          <div className="receipt-view">
            <Receipt bill={bill} duplicate={job.duplicate} />
          </div>
        </div>
      </Dialog>
    );
  }
  return createPortal(
    <div className="print-host">
      <Receipt bill={job.bill} duplicate={job.duplicate} />
    </div>,
    document.body,
  );
}

/** Prints the bill, or shows it on screen on a laptop with no bill printer.
 *  Only real prints are recorded, so the first printed copy is never marked DUPLICATE. */
export async function printBill(bill: Bill, options: { onScreen?: boolean } = {}): Promise<void> {
  if (options.onScreen ?? output === "screen") {
    const printed = Math.max(bill.print_count, printCounts.get(bill.id) ?? 0);
    startJob?.({ bill, duplicate: printed >= 1, onScreen: true });
    return;
  }
  const result = await api.post<{ print_count: number; duplicate: boolean }>(`/api/bills/${bill.id}/printed`);
  printCounts.set(bill.id, result.print_count);
  startJob?.({ bill, duplicate: result.duplicate, onScreen: false });
}
