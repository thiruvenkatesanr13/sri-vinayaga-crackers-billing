import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Boxes,
  CalendarClock,
  ChartColumn,
  Files,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Package,
  Printer,
  Receipt,
  ScreenShare,
  Settings,
  Truck,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { useSession } from "../lib/session";
import { PrintHost, setBillOutput, useBillOutput } from "../lib/print";
import { brand } from "../lib/brand";
import { Button, Dialog, IconButton } from "./ui";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/billing", label: "Billing", icon: Receipt },
  { to: "/bills", label: "Bills", icon: Files },
  { to: "/bookings", label: "Bookings", icon: CalendarClock },
  { to: "/products", label: "Products", icon: Package },
  { to: "/stock", label: "Stock", icon: Boxes },
  { to: "/purchases", label: "Purchases", icon: Truck, owner: true },
  { to: "/customers", label: "Customers", icon: Users },
  { to: "/cash", label: "Expenses & closing", icon: Wallet },
  { to: "/reports", label: "Reports", icon: ChartColumn },
  { to: "/settings", label: "Settings", icon: Settings, owner: true },
];

/** True while the window is at least `px` wide; follows the window as it is resized. */
function useWideWindow(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setWide(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return wide;
}

export function CounterPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { boot, counterId, setCounterId } = useSession();
  const output = useBillOutput();
  return (
    <Dialog open={open} title="This laptop" onClose={onClose}>
      <div className="stack">
        <h3>Which counter is this?</h3>
        <p className="muted small">Bills saved on this laptop are marked with this counter. You can change it later.</p>
        <div className="people">
          {boot.counters.map((counter) => (
            <button
              key={counter.id}
              type="button"
              className="person"
              aria-pressed={counter.id === counterId}
              onClick={() => {
                setCounterId(counter.id);
                onClose();
              }}
            >
              <Monitor size={18} aria-hidden />
              {counter.name}
            </button>
          ))}
        </div>
        <h3>Bill printer</h3>
        <div className="people">
          <button type="button" className="person" aria-pressed={output === "print"} onClick={() => setBillOutput("print")}>
            <Printer size={18} aria-hidden />
            Print bills
            <small>The 80 mm printer is the Windows default printer</small>
          </button>
          <button type="button" className="person" aria-pressed={output === "screen"} onClick={() => setBillOutput("screen")}>
            <ScreenShare size={18} aria-hidden />
            Show bills on screen
            <small>No printer on this laptop</small>
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export default function AppShell() {
  const { boot, me, isOwner, counterName, logout } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickCounter, setPickCounter] = useState(false);
  const location = useLocation();
  const wide = useWideWindow(1500);
  // On a smaller laptop billing needs every pixel, so the menu shows icons only there. Wide screens keep the full menu.
  const compact = location.pathname.startsWith("/billing") && !menuOpen && !wide;

  useEffect(() => setMenuOpen(false), [location.pathname]);

  const rail = (
    <aside className={`rail ${menuOpen ? "open" : ""}`} aria-label="Main menu">
      <div className="brand">
        <div className="brand-row">
          <img className="brand-mark" src={brand.mark} alt="" width={44} height={44} />
          <div className="wordmark">{boot.shop_name}</div>
          {menuOpen ? (
            <IconButton label="Close menu" onClick={() => setMenuOpen(false)}>
              <X size={18} />
            </IconButton>
          ) : null}
        </div>
        <div className="brand-sub">
          <span>{boot.tagline}</span>
        </div>
      </div>
      <nav className="nav">
        {NAV.filter((item) => !item.owner || isOwner).map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} title={compact ? item.label : undefined}>
            <item.icon size={18} aria-hidden />
            <span className="nav-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="rail-foot">
        <div className="who-row">
          <div className="who-block">
            <div className="who">{me.name}</div>
            <div className="muted small">{isOwner ? "Owner" : "Staff"}</div>
          </div>
          <IconButton label={`Log out ${me.name}`} onClick={() => void logout()}>
            <LogOut size={16} />
          </IconButton>
        </div>
        <Button size="sm" onClick={() => setPickCounter(true)} title={compact ? `${counterName ?? "Choose counter"} (change)` : undefined}>
          <Monitor size={14} aria-hidden />
          <span className="nav-label">{counterName ?? "Choose counter"}</span>
        </Button>
      </div>
    </aside>
  );

  return (
    <div className={`shell${compact ? " compact" : ""}`}>
      {rail}
      {menuOpen ? <div className="scrim" style={{ zIndex: 45 }} onClick={() => setMenuOpen(false)} /> : null}
      <div className="main">
        <div className="topbar">
          <IconButton label="Open menu" onClick={() => setMenuOpen(true)}>
            <Menu size={20} />
          </IconButton>
          <img className="brand-mark" src={brand.mark} alt="" width={32} height={32} />
          <div className="wordmark">{boot.shop_name}</div>
        </div>
        <Outlet context={{ openCounterPicker: () => setPickCounter(true) }} />
      </div>
      <CounterPicker open={pickCounter} onClose={() => setPickCounter(false)} />
      <PrintHost />
    </div>
  );
}
