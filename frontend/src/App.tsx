import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { errorText } from "./lib/api";
import { SessionProvider, useBootstrap, useSession } from "./lib/session";
import { Button, Loading, Notice } from "./components/ui";
import AppShell from "./components/AppShell";
import LicenseGate from "./components/LicenseGate";
import SetupPage from "./pages/SetupPage";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import BillingPage from "./pages/BillingPage";
import BillsPage from "./pages/BillsPage";
import PrintPage from "./pages/PrintPage";
import BookingsPage from "./pages/BookingsPage";
import ProductsPage from "./pages/ProductsPage";
import StockPage from "./pages/StockPage";
import PurchasesPage from "./pages/PurchasesPage";
import CustomersPage from "./pages/CustomersPage";
import CashPage from "./pages/CashPage";
import ReportsPage from "./pages/ReportsPage";
import SettingsPage from "./pages/SettingsPage";

function OwnerOnly({ children }: { children: ReactNode }) {
  const { isOwner } = useSession();
  return isOwner ? <>{children}</> : <Navigate to="/" replace />;
}

export default function App() {
  const boot = useBootstrap();
  if (boot.isPending) {
    return (
      <div className="gate-main" style={{ minHeight: "100dvh" }}>
        <Loading label="Opening billing" />
      </div>
    );
  }
  if (boot.isError) {
    return (
      <div className="gate-main" style={{ minHeight: "100dvh" }}>
        <div className="gate-card">
          <Notice tone="bad">{errorText(boot.error)}</Notice>
          <Button variant="primary" onClick={() => boot.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  const data = boot.data;
  if (!data.license.ok) return <LicenseGate boot={data} />;
  if (data.setup_required) return <SetupPage />;
  if (!data.me) return <LoginPage boot={data} />;

  return (
    <SessionProvider boot={data}>
      <Routes>
        <Route path="/print/:id" element={<PrintPage />} />
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="billing" element={<BillingPage />} />
          <Route path="bills" element={<BillsPage />} />
          <Route path="bookings" element={<BookingsPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="stock" element={<StockPage />} />
          <Route
            path="purchases"
            element={
              <OwnerOnly>
                <PurchasesPage />
              </OwnerOnly>
            }
          />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="cash" element={<CashPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route
            path="settings"
            element={
              <OwnerOnly>
                <SettingsPage />
              </OwnerOnly>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </SessionProvider>
  );
}
