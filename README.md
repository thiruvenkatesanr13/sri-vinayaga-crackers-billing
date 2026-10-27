# Sri Vinayaga Crackers — Billing

**To install and run billing on a Windows laptop, follow [HOW_TO_RUN.md](HOW_TO_RUN.md).**

Billing, stock and day-closing software for Sri Vinayaga Crackers: one shop with two billing counters. The software runs on the shop's billing laptop (Counter 1). The second counter laptop opens it in Chrome or Edge over the shop Wi-Fi. The screens are designed for laptop screens (1280×640 CSS pixels and up). Billing keeps working with no internet. Backups are kept on the billing laptop and copied to a Google Drive folder.

- **Backend:** Django 5.2 + Django REST Framework, SQLite (WAL), served by Waitress. Code is in `backend/`.
- **Frontend:** React 19 + TypeScript + Vite + TanStack Query. Code is in `frontend/` and it builds into `backend/frontend_dist/`, which Django serves with WhiteNoise. The shop PC needs only Python. Node.js is needed only to rebuild the screens.
- **Windows scripts:** `scripts/*.bat` handle install, start (with automatic restart), auto-start, firewall, the kiosk browser window, backup, restore, PIN reset and a fresh start (`clear_data.bat`).

The owner-facing install and daily-use guide is [docs/OWNER_GUIDE.md](docs/OWNER_GUIDE.md). To install and run it on a new laptop, start with [HOW_TO_RUN.md](HOW_TO_RUN.md).

## Folder layout

```
backend/
  config/        settings, URLs, WSGI
  core/          shop settings, users + PIN login, counters, audit log, LAN host check
  catalog/       categories, products, gift boxes, stock-sheet Excel import (Qty Add, QTY Removed, bundle size, price)
  inventory/     stock places, stock balance + movement ledger, transfers, adjustments, suppliers, purchases
  sales/         bills (estimate / GST invoice), payments, bookings with advance, held bills, customers
  cash/          expenses, day open / close
  reports/       dashboard numbers (live, for any dates), 5 reports + Excel export
  backups/       SQLite snapshot + Excel backups to data/backups and Google Drive; restore command
  serve.py       production entry point (Waitress, migrations, auto-backup thread)
frontend/src/
  pages/         one file per screen
  components/    shared UI (ui.tsx), app shell, receipt, product picker
  lib/           API client, money maths (mirrors core/money.py), session, printing (per laptop: printer connected, or no printer = save only), WhatsApp links (bill message for the customer, day summary for the owner), brand (logo files)
  assets/brand/  the shop logo: logo-original.png (as supplied) and the cut versions used by the app
                 (logo.webp full logo, logo-mark.webp round Ganesha mark, logo-receipt.png black line art for the printer)
  styles/        tokens.css (design tokens), app.css, inventory.css, print.css (80 mm receipt)
scripts/         Windows .bat helpers
data/            created at first run: db.sqlite3, backups/, imports/, media/, logs/, secret_key.txt
```

`data/` holds the shop's real records. Never copy it to another PC, and never ship it with an update.

## Developer setup

Python 3.12+ and Node.js 20.19+ (only for the screens).

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
cd frontend; npm.cmd ci; cd ..
```

Run it in two windows:

```powershell
# API on :8000 (DEBUG on, so tracebacks show)
$env:SVC_DEBUG = "1"; .venv\Scripts\python.exe backend\manage.py runserver 8000
# Screens with hot reload on :5173 (proxies /api and /media to :8000)
cd frontend; npm.cmd run dev
```

Open http://localhost:5173. The first visit shows the one-time Setup screen: create the owner and their PIN. Setup also makes Counter 1 and Counter 2, the Shop and the Godown.

To try the production setup locally, build the screens and then run `backend\serve.py`:

```powershell
scripts\build_frontend.bat        # tsc + vite build into backend\frontend_dist
.venv\Scripts\python.exe backend\serve.py
```

After rebuilding the screens, restart `serve.py`. WhiteNoise only lists the asset files at startup.

## Settings (environment variables)

| Variable | Default | Use |
| --- | --- | --- |
| `SVC_PORT` | `8000` | Port for `serve.py`. If you change it, change `scripts/allow_network.bat` and `scripts/open_billing.bat` too. |
| `SVC_DATA_DIR` | `<project>/data` | Where the database, backups, photos and logs live. |
| `SVC_AUTO_BACKUP` | `1` | `0` turns off the automatic backups (Hourly 7 am to 10 pm, Day at 11 pm). |
| `SVC_EXTRA_HOSTS` | (empty) | Extra host names allowed besides localhost, this PC's name and private LAN IPs. |
| `SVC_DEBUG` | off | `1` turns on Django DEBUG. Use only for development. |
| `SVC_SECRET_KEY` | generated | Otherwise the key is created once in `data/secret_key.txt`. |

The rest of the shop settings (shop name, phones, bill number prefixes, the discount already applied on a new bill, GST, Google Drive folder, the owner's WhatsApp number for the day summary) are edited by the owner in **Settings** and stored in the database. Whether a laptop has a bill printer (**Save & print**) or not (**Save**, then Send on WhatsApp) is chosen per laptop (counter button) and kept in that browser (`svc.bill-output` in localStorage).

## Rules the code relies on

- **Money is integer paise**, and percentages are basis points (10% = 1000). Rounding is half-up. Bill maths (`core/money.py` `bill_totals`, mirrored by `frontend/src/lib/money.ts` `computeTotals`) runs in this order: items total → whole-bill discount → GST (inclusive or exclusive) → round to the rupee. The server recalculates every bill and rejects it if the screen's total is different (`price_changed`).
- **Billers have no limits.** The whole-bill discount can be anything from 0 to 100% (`default_discount_bp`, 50% unless changed, only sets where a new bill starts).
  - A line can carry `rate_paise`, a rate for that bill only: `InvoiceLine.unit_price_paise` is what was charged, and `list_price_paise` keeps the product's own price when they differ.
  - `total_override_paise` is a total typed by the biller. `bill_totals(total_paise=...)` makes the bill come to exactly that: the difference is `adjustment_paise`, applied after the discount (before GST when GST is added on top), GST is worked out again from the new total, and there is no round off. `taxable_paise` includes the adjustment, so the product, category and profit reports stay right.
  - Payments need not match the amount due. Cash given below the cash amount counts as the cash paid. `Invoice.balance_paise` keeps what was left unpaid (below zero when the customer paid more).
  - The audit log records rate changes, typed totals, discounts other than the default, and balances.
- **Stock never goes negative.** `inventory.services.change_stock` does a conditional update inside the transaction, backed by a database CHECK constraint. Every change is written to the `StockMovement` ledger, which is never edited.
- **Bills are idempotent.** Each draft carries a `client_uuid`, so a double-tapped Save or a retried request can't create two bills. Bill numbers come from `NumberSequence` inside the same transaction (`E-00001`, `G-00001`, and so on), so the two counters can never get the same number.
- **Cancelling a bill** returns its stock and records a refund payment. The bill itself is kept and marked cancelled. Reports never count cancelled bills.
- **Roles:** staff never receive cost or profit fields. Owner-only endpoints are enforced on the server, not just hidden in the UI. Every important action goes to the audit log (Settings → Activity log).
- **PINs** are hashed. Owner PINs are 6–8 digits and staff PINs 4–8, and obvious PINs are refused. Five wrong tries lock the user for 5 minutes.
- **LAN only:** `LanHostMiddleware` accepts only localhost, this PC's name and private IP addresses, which blocks DNS-rebinding tricks. The firewall rule from `allow_network.bat` covers Private networks only.
- **Stock-sheet import adds and takes off the amounts typed.** Qty Add is added and QTY Removed is taken off (reasons `sheet_add` / `sheet_remove`). `Product.import_last` keeps the numbers, price and bundle size from the item's last import. An amount equal to last time's number is held back (`repeat_add` / `repeat_remove` in the preview) unless the row is sent in `again_rows`, so the sheet never needs clearing and importing it twice changes nothing. A price or bundle size edited in the app stays until the sheet's own value changes.
- **Changing a booking's advance** (`sales.services.change_advance`) corrects the payment in place while its day is still open. Otherwise it records the difference today as an advance or a refund, so closed days never change.

## Backups and Google Drive

Google Drive for Desktop is installed on the billing laptop, signed in to the shop's Google account, and a folder inside it is set in **Settings → Backup**. Google Drive for Desktop does the syncing, so no Google API keys are needed.

`create_backup()` does the following:

1. Takes a consistent SQLite snapshot. The name says which kind it is:
   - `Hourly_<YYYY-MM-DD>_<HH-MM>.sqlite3`: every hour from 7 am to 10 pm, from **Back up now** (Dashboard or Settings) and from `scripts\backup_now.bat`. Today's and yesterday's are kept (`HOURLY_BACKUP_DAYS`).
   - `Day_<YYYY-MM-DD>.sqlite3`: at day closing and at 11 pm (`backup_now --day`). Kept all season. A backup with the same name is replaced, so the Day file always holds the latest state of that day. If a day with sales ended without one (the laptop was off), `serve.py` makes it when billing starts.
2. Writes an Excel copy with the same name from that snapshot (`backups/excel.py`: About with the backup type, Bills with their items, Stock with sold quantities, Bookings, Expenses). Both files stay locally in `data/backups/`.
3. Copies both files into the Drive folder, and product photos into a `media` folder there.
4. Removes Hourly backups older than yesterday, in pairs, here and in Drive. Day files and older `backup_*` files are never removed.

If the Excel copy fails, the database backup still completes and the error shows in Settings.

`scripts\restore_backup.bat` (`manage.py restore_backup`) restores a backup into the live database. It refuses the Excel copy, refuses to run while the server is running, and saves a "before-restore" copy first.

`scripts\clear_data.bat` (`manage.py clear_data`) is the full fresh start, as on a new install. It deletes every row of the models in `CLEARED`, in an order that respects the protected foreign keys: all of `core`, `catalog`, `inventory`, `sales` and `cash`, plus sessions, so everyone is logged out. It also deletes product photos and uploaded sheets. With no users left, `/api/bootstrap` reports `setup_required` and the Set up screen recreates the owner, counters, Shop, Godown and default categories. It saves a "before-clear" snapshot first and never touches `data/backups` or the Drive folder. It can run while the server is up, and the new activity log starts with one `data.clear` entry. A new model must be added to `CLEARED`.

**Dashboard.** The request is `/api/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD` (today by default, up to 400 days).

- `reports.stats.dashboard_stats` runs plain SQL on the live database.
- Stock alerts, bookings due and held bills are current; everything else follows the dates.
- Staff never get profit.

## Releasing an update to the shop

1. If anything in `frontend/src` changed, run `scripts\build_frontend.bat`.
2. Commit and push to GitHub. `.gitignore` keeps `data/`, `.venv/`, `frontend/node_modules/` and other local files out of the repository.
3. On the billing laptop, close the server window and replace the code folders with the new ones (from GitHub: **Code → Download ZIP**). Never replace or delete `data`. Run `scripts\install.bat` (it updates packages and applies migrations), then `scripts\start_billing.bat`. Counter 2 needs nothing; it gets the new screens on its next reload.
