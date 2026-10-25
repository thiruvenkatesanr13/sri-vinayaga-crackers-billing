import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { billMessage, isValidPhone, openWhatsApp } from "../lib/whatsapp";
import type { Bill } from "../lib/types";
import { Button, Dialog, Field } from "./ui";

/** Sends a saved bill to the customer on WhatsApp as a message. Asks for the number when the bill has none. */
export default function WhatsAppBillButton({ bill }: { bill: Bill }) {
  const [asking, setAsking] = useState(false);
  const [phone, setPhone] = useState("");
  const known = isValidPhone(bill.customer_phone) ? bill.customer_phone : "";

  function send(to: string) {
    openWhatsApp(to, billMessage(bill));
    setAsking(false);
  }

  return (
    <>
      <Button onClick={() => (known ? send(known) : setAsking(true))} title={known ? `To ${known}` : undefined}>
        <MessageCircle size={16} aria-hidden /> Send on WhatsApp
      </Button>
      <Dialog
        open={asking}
        title={`Send bill ${bill.number} on WhatsApp`}
        onClose={() => setAsking(false)}
        footer={
          <>
            <Button onClick={() => setAsking(false)}>Cancel</Button>
            <Button variant="primary" disabled={!isValidPhone(phone)} onClick={() => send(phone)}>
              Open WhatsApp
            </Button>
          </>
        }
      >
        <Field label="Customer's WhatsApp number" hint="Typing the number under Customer before saving skips this step.">
          <input
            className="input"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && isValidPhone(phone) && send(phone)}
            autoFocus
          />
        </Field>
      </Dialog>
    </>
  );
}
