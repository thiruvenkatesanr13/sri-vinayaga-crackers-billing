import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { brand } from "./brand";
import type { Bill } from "./types";
import Receipt from "../components/Receipt";

type Job = { bill: Bill; duplicate: boolean };
let startJob: ((job: Job) => void) | null = null;

/** Whether this laptop has a bill printer. Without one, bills are saved without printing and sent on WhatsApp. */
const PRINTER_KEY = "svc.bill-output";
const printerListeners = new Set<() => void>();

function readHasPrinter(): boolean {
  try {
    // "screen" was the older "show bills on screen" choice, made on laptops without a printer.
    const stored = window.localStorage.getItem(PRINTER_KEY);
    return stored !== "none" && stored !== "screen";
  } catch {
    return true;
  }
}

let hasPrinter = readHasPrinter();

export function setHasPrinter(value: boolean) {
  hasPrinter = value;
  try {
    window.localStorage.setItem(PRINTER_KEY, value ? "print" : "none");
  } catch {
    // Storage is blocked: the choice lasts until the page is reloaded.
  }
  printerListeners.forEach((listener) => listener());
}

export function useHasPrinter(): boolean {
  return useSyncExternalStore(
    (listener) => {
      printerListeners.add(listener);
      return () => printerListeners.delete(listener);
    },
    () => hasPrinter,
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
 *  Chrome started with --kiosk-printing prints straight to the default (80 mm) printer. */
export function PrintHost() {
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    startJob = setJob;
    void receiptLogoReady();
    return () => {
      startJob = null;
    };
  }, []);

  useEffect(() => {
    if (!job) return;
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
  return createPortal(
    <div className="print-host">
      <Receipt bill={job.bill} duplicate={job.duplicate} />
    </div>,
    document.body,
  );
}

/** Records the print (so reprints say DUPLICATE) and prints the bill. */
export async function printBill(bill: Bill): Promise<void> {
  const result = await api.post<{ print_count: number; duplicate: boolean }>(`/api/bills/${bill.id}/printed`);
  startJob?.({ bill, duplicate: result.duplicate });
}
