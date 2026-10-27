export type Role = "owner" | "staff";

export interface Me {
  id: number;
  name: string;
  role: Role;
  is_owner: boolean;
}

export interface Bootstrap {
  setup_required: boolean;
  shop_name: string;
  shop_name_tamil: string;
  tagline: string;
  users: { id: number; name: string; role: Role }[];
  counters: { id: number; name: string }[];
  me: Me | null;
}

export interface Settings {
  shop_name: string;
  shop_name_tamil: string;
  tagline: string;
  address: string;
  phones: string;
  gstin: string;
  bank_details: string;
  upi_id: string;
  footer_terms: string;
  footer_thanks: string;
  estimate_prefix: string;
  gst_prefix: string;
  booking_prefix: string;
  round_off: boolean;
  default_discount_bp: number;
  gst_rate_bp: number | null;
  hsn_code: string;
  prices_include_gst: boolean | null;
  gst_ready: boolean;
  low_stock_default: number | null;
  backup_folder: string;
  owner_whatsapp: string;
  updated_at: string;
}

export interface Category {
  id: number;
  name: string;
  code: string;
  sort_order: number;
}

export interface Product {
  id: number;
  code: string;
  name: string;
  category_id: number;
  category_name: string;
  brand: string;
  unit_name: string;
  units_per_case: number | null;
  price_paise: number;
  case_price_paise: number | null;
  low_stock_level: number | null;
  photo_url: string | null;
  is_active: boolean;
  is_gift_box: boolean;
  gift_box_mode: "own" | "components";
  stock: Record<string, number>;
  sale_stock: number;
  box_items: { component_id: number; quantity: number }[];
  cost_paise?: number | null;
  margin_bp?: number | null;
  updated_at: string;
}

export interface Location {
  id: number;
  name: string;
  kind: "shop" | "godown";
  is_active: boolean;
  is_sale_location: boolean;
}

export interface Counter {
  id: number;
  name: string;
  is_active: boolean;
  sort_order: number;
}

export type PaymentMode = "cash" | "upi" | "card" | "credit_card" | "bank";

export const PAYMENT_MODES: { value: PaymentMode; label: string; short?: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "credit_card", label: "Credit card" },
  { value: "bank", label: "Bank transfer", short: "Bank" },
];

export const MODE_LABEL: Record<string, string> = Object.fromEntries(PAYMENT_MODES.map((m) => [m.value, m.label]));

export interface PaymentRow {
  id: number;
  kind: "sale" | "advance" | "refund";
  mode: PaymentMode;
  mode_label: string;
  amount_paise: number;
  reference: string;
  cash_tendered_paise: number | null;
  change_paise: number | null;
  business_date: string;
  at: string;
}

export interface BillSummary {
  id: number;
  number: string;
  doc_type: "estimate" | "gst";
  status: "active" | "cancelled";
  business_date: string;
  at: string;
  counter_name: string;
  user_name: string;
  customer_name: string;
  customer_phone: string;
  total_paise: number;
  /** Still to be paid when the bill was saved; below zero when the customer paid more. */
  balance_paise: number;
  print_count: number;
}

export interface BillLine {
  line_no: number;
  product_id: number;
  code: string;
  name: string;
  category: string;
  sale_unit: "unit" | "case";
  unit_label: string;
  qty: number;
  base_qty: number;
  unit_price_paise: number;
  /** The item's own price when the rate was changed on this bill; null when it was not changed. */
  list_price_paise: number | null;
  amount_paise: number;
  group_label: string;
}

export interface ShopSnapshot {
  shop_name: string;
  shop_name_tamil: string;
  tagline: string;
  address: string;
  phones: string;
  footer_terms: string;
  footer_thanks: string;
  upi_id: string;
  gstin?: string;
  hsn_code?: string;
}

export interface Bill extends BillSummary {
  client_uuid: string;
  subtotal_paise: number;
  discount_bp: number;
  discount_paise: number;
  taxable_paise: number;
  gst_rate_bp: number | null;
  prices_include_gst: boolean | null;
  cgst_paise: number;
  sgst_paise: number;
  round_off_paise: number;
  adjustment_paise: number;
  advance_paise: number;
  amount_due_paise: number;
  booking_number: string | null;
  shop: ShopSnapshot;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string;
  lines: BillLine[];
  payments: PaymentRow[];
  cost_paise?: number | null;
}

export interface Paged<T> {
  count: number;
  results: T[];
}

export interface HeldBill {
  id: number;
  counter_id: number;
  label: string;
  total_paise: number;
  payload: DraftPayload;
  user_name: string;
  at: string;
}

export interface DraftLine {
  key: string;
  product_id: number;
  sale_unit: "unit" | "case";
  qty: number;
  group_label: string;
  /** A rate typed by the biller for this bill (per unit or per bundle); empty uses the item's own price. */
  rate_paise?: number | null;
}

export interface DraftPayload {
  lines: DraftLine[];
  doc_type: "estimate" | "gst";
  discount_bp: number;
  customer_name: string;
  customer_phone: string;
  booking_id: number | null;
  booking_number: string | null;
  booking_advance_paise: number;
  /** A total typed by the biller, and the worked-out total it replaced; dropped when the bill changes. */
  total_override_paise?: number | null;
  total_override_base?: number | null;
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  kind: "walk_in" | "regular" | "dealer";
}

export interface BookingSummary {
  id: number;
  number: string;
  status: "booked" | "ready" | "delivered" | "cancelled";
  customer_name: string;
  customer_phone: string;
  address: string;
  delivery_date: string;
  note: string;
  estimate_paise: number;
  advance_paise: number;
  created_at: string;
  cancelled_reason: string;
  bill: { id: number; number: string; total_paise: number } | null;
}

export interface Booking extends BookingSummary {
  lines: {
    product_id: number;
    code: string;
    name: string;
    sale_unit: "unit" | "case";
    qty: number;
    price_paise: number;
    units_per_case: number | null;
    unit_name: string;
  }[];
  payments: PaymentRow[];
  /** After a change to the advance from a closed day: how the difference was recorded today. */
  advance_note?: string;
}

export interface StockAlert {
  code: string;
  name: string;
  unit: string;
  location: string;
  qty: number;
  level: number | null;
  status: "out" | "low";
}

export interface DashboardStats {
  sales_total_paise: number;
  bills: number;
  average_bill_paise: number;
  discount_total_paise: number;
  cancelled_bills: number;
  payments_by_mode: Record<PaymentMode, number>;
  chart: {
    unit: "day" | "week" | "month";
    from: string;
    to: string;
    points: { date: string; to: string; total_paise: number; bills: number }[];
  };
  top_products: { code: string; name: string; unit: string; qty: number; amount_paise: number }[];
  stock_alerts: StockAlert[];
  out_of_stock: number;
  low_stock: number;
  bookings_due: {
    number: string;
    customer_name: string;
    customer_phone: string;
    delivery_date: string;
    status: string;
    overdue: boolean;
  }[];
  held_bills: number;
  expenses_paise: number;
  profit?: {
    profit_paise: number;
    costed_sales_paise: number;
    bills_without_cost: number;
    sales_without_cost_paise: number;
  };
}

export interface BackupStatus {
  last_local_at?: string;
  last_local_file?: string;
  last_local_excel?: string | null;
  last_kind?: "hourly" | "day";
  last_hourly_at?: string;
  last_day_at?: string;
  last_day_file?: string;
  excel_error?: string | null;
  last_drive_at?: string;
  drive_configured?: boolean;
  drive_error?: string | null;
  drive_error_at?: string;
}

export interface Dashboard {
  today: string;
  is_owner: boolean;
  period: { from: string; to: string; days: number };
  stats: DashboardStats;
  backup?: BackupStatus;
}

export interface ReportColumn {
  key: string;
  label: string;
  type: "money" | "int" | "text" | "percent";
}

export interface Report {
  kind: string;
  title: string;
  period: string;
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  totals: Record<string, string | number | null>;
  notes: string[];
  missing_cost?: { code: string; name: string; qty: number; net_paise: number }[];
}

export interface DaySummary {
  business_date: string;
  opened: boolean;
  closed: boolean;
  opening_cash_paise: number | null;
  sales_count: number;
  sales_total_paise: number;
  discount_total_paise: number;
  cancelled_count: number;
  payments_by_mode: Record<PaymentMode, number>;
  cash_sales_paise: number;
  cash_advances_paise: number;
  cash_refunds_paise: number;
  expenses_total_paise: number;
  expenses_from_drawer_paise: number;
  expenses_by_category: Record<string, number>;
  expected_cash_paise: number;
  counted_cash_paise: number | null;
  difference_paise: number | null;
  handed_over_paise: number | null;
  closed_at: string | null;
  closed_by: string | null;
  note: string;
}

export interface Expense {
  id: number;
  business_date: string;
  category: string;
  category_label: string;
  amount_paise: number;
  note: string;
  paid_from_drawer: boolean;
  user: string;
  at: string;
}
