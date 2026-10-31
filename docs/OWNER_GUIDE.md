# Sri Vinayaga Crackers billing — set-up and daily guide

This guide is for the person installing the software (ElevateYourself) and for the owner and staff who use it every day.

**How it works in one minute.** The shop has two billing counters.
- **Counter 1 is the billing laptop.** The software runs on it and keeps all the bills and stock.
- **Counter 2 is a second laptop.** It opens the same billing screens over the shop Wi-Fi, and nothing is installed on it.

Billing does not need the internet. Backups are saved on the billing laptop and copied to Google Drive.

The screens are made for laptop screens (1280 pixels wide or more), used in Chrome or Edge.

---

## Part 1 — One-time set-up

### On the billing laptop (Counter 1)

#### 1. Install Python

1. Download Python 3.12 or newer from python.org (Windows installer, 64-bit).
2. On the first screen, tick **Add python.exe to PATH**, then click **Install Now**.

#### 2. Copy the software

Copy the `Elevate_Yourself_Cracker_Billing` folder to `C:\SriVinayagaBilling`. If the folder you copy from has `.venv`, `data` or `frontend\node_modules` folders, leave them out: they belong to the PC the copy came from.

Do **not** put it on the Desktop, in Downloads, in OneDrive or inside the Google Drive folder. A sync program copying the database while it's open can damage it. Backups reach Google Drive the safe way, as a copy.

#### 3. Install

Double-click `scripts\install.bat` and wait for **Installed.** It takes a few minutes the first time.

#### 4. Let Counter 2 connect

1. Windows Settings → Network & internet → your Wi-Fi (or the mobile hotspot) → set **Network profile type** to **Private**.
2. Right-click `scripts\allow_network.bat` → **Run as administrator**.

#### 5. Start billing, and make it start by itself

1. Double-click `scripts\start_billing.bat`. A black window opens and shows two addresses, for example:

   ```
   1. On this PC:      http://localhost:8000
   2. Other counters:  http://192.168.1.20:8000
   ```

   - Address 1 is for this laptop and address 2 is for Counter 2.
   - If address 2 says to connect to the shop Wi-Fi, join the Wi-Fi and start billing again.
   - **Keep this window open** (you can minimise it). If billing ever stops by itself, the window starts it again after 10 seconds.
2. Double-click `scripts\setup_autostart.bat` once. From now on billing starts by itself whenever the laptop is switched on and someone logs in to Windows.

Ask whoever manages the Wi-Fi router to give the billing laptop a fixed address (a "DHCP reservation"). Otherwise the address Counter 2 uses can change after a restart.

#### 6. Open billing and set up the shop

1. Double-click `scripts\open_billing.bat`. Billing opens in its own window (Chrome or Edge, no address bar). Put a shortcut to this file on the desktop.
2. The first time, the **Set up this PC** screen appears. Type the owner's name and a 6–8 digit PIN. Don't use 123456 or one digit repeated. This also makes Counter 1, Counter 2, the Shop and the Godown.
3. Choose **Counter 1** when asked.

#### 7. Settings (owner)

Open **Settings** and work through the tabs:

- **Shop details** — name, Tamil name, phones, address, UPI ID, bank details, and the two lines at the bottom of the bill.
- **Bills & GST**
  - Bill number prefixes. Bills look like `E-00001`.
  - The discount already applied on a new bill (none unless the owner sets one; billers can still give any discount on each bill), and the low-stock warning level.
  - GST invoices stay switched off until the GSTIN, GST rate and HSN code are filled in.
- **People & PINs**
  - Add each staff member with their own PIN (4–8 digits).
  - Staff can bill, but they cannot see cost or profit, cancel bills, or change prices or settings.
  - We suggest adding a **second owner**, for example a family member, so the shop is never stuck if one owner forgets their PIN.
- **Counters & places** — rename the counters, or add another stock place.
- **Backup** — see step 9.
- **WhatsApp** — the owner's number for the day-end summary. (Bills go to customers from the saved bill; see Billing.)

#### 8. Load the products and stock

On **Products**, use **Import from Excel** with the shop's stock sheet. Its columns are **Sparkle**, **QTY Removed**, **Qty Add**, **How many cases for a bundle** and **Final Price**, with each category name on its own row above its items.

- **Qty Add** is added to the stock and **QTY Removed** is taken off. Type this time's amount: with 300 in stock, Qty Add 50 makes it 350, and QTY Removed 50 makes it 250. Then import the sheet again.
- You never need to clear the sheet. A number that is the same as at the last import is not used again, so importing the same sheet twice changes nothing. If an item really got the same amount again (50 after 50), tick **Again** on that item in the preview.
- **QTY Removed** is for stock taken out for other reasons, like damage. Bills already take sold stock off.
- **How many cases for a bundle** is how many pieces make one bundle, or **Nil** if the item isn't sold as a bundle. Items with a bundle size get a **Bundle** button in billing. The size can also be changed on each item in **Products**.
- **Final Price** is the item's selling price. New bills start with no discount, so the item is billed at this price unless the biller gives a discount (see Billing). A price or bundle size changed in the app stays until the sheet changes it.
- In *Add and take off stock at*, choose where that stock actually is: the **Shop** or the **Godown**.
- Check the preview before importing. For every item it shows the stock before and after, and any price or bundle change. Rows marked for a check are worth a look: a possible typo, a name that looks cut off, or a guessed category.
- An item renamed in the sheet comes in as a new item. To keep its stock and sales together, rename it in **Products** first.

Gift box contents and cost prices (for profit) can be set on each product afterwards.

#### 9. Google Drive backup

1. Install **Google Drive for Desktop** on the billing laptop and sign in with the **shop's** Google account.
2. In Google Drive, make a folder such as `My Drive\SriVinayagaBackups`.
3. In **Settings → Backup**, paste that folder's full path (for example `G:\My Drive\SriVinayagaBackups`) and save. Press **Back up now** to test it.

#### 10. Bill printer

1. Install the 80 mm thermal printer's driver and make it the **default printer** in Windows (Settings → Bluetooth & devices → Printers & scanners; turn off *Let Windows manage my default printer* first).
2. In the printer's preferences, set the paper to 80 mm (roll) and margins to none, if those options exist.
3. Always open billing with `open_billing.bat`. In that window, bills print straight away with no print dialog. The screen flickers for a moment while a bill prints; that is normal.

Bills always go to the **default** printer. If that is *OneNote* or *Microsoft Print to PDF*, the bill quietly goes there and nothing comes out.

**No printer on a laptop?** Press the counter button at the bottom of the menu and choose **No printer**. Billing then shows **Save** instead of **Save & print**: bills are saved without printing, and the saved bill has **Send on WhatsApp**. Choose **Printer connected** again once a printer is set up. Each laptop keeps its own choice.

### On Counter 2

Nothing needs to be installed.

1. Connect the laptop to the shop Wi-Fi.
2. Copy the `scripts` folder to it.
3. Make a desktop shortcut to `open_billing.bat` and add address 2 after the file name in the shortcut, for example `open_billing.bat http://192.168.1.20:8000`. Billing always opens as a full-screen window. You can also just open address 2 in Chrome or Edge, but bills will then show a print dialog.
4. If Counter 2 has its own printer, set it up as in step 10. If it has none, choose **No printer** as in step 10.
5. Log in, and choose **Counter 2** when asked.

Both counters work on the same shop: one stock, one series of bill numbers, and one day closing. Every bill shows which counter made it.

---

## Part 2 — Every day

### Morning

- Switch on the billing laptop first. Billing starts by itself. Then open billing on Counter 2.
- **Expenses & closing → Open the day:** count the cash in the drawer and enter it.

### Billing

- Tap an item, or type part of its name or code and press **Enter**. The item is added with quantity **1** and the cursor in its **quantity** box, with the 1 highlighted: type the count to replace it, or leave it as 1. Press **Enter** to go back to the search box for the next item. **+ / −** also change the quantity. Use **Bundle** to sell a full bundle.
- **Discount** applies to the whole bill. New bills start with **no discount** (the owner can set a starting discount in Settings → Bills & GST). Tap 0%, 5%, 10% or **Other** to give any discount from 0% to 100%; there is no limit.
- **Change an item's rate:** tap the rate under the item (for example *₹42.00 / Box*) and type the rate for this bill. It turns blue with the usual price crossed out. Clear it to go back. The price in Products does not change.
- **Change the total:** tap the total and type the amount agreed with the customer. The difference shows on the bill as **Adjustment**; tap **Undo** next to it to remove it. Changing the items or the discount afterwards drops the typed total, so type it last.
- **Customer** — add the customer's phone number and name to put them on the bill and to send it on WhatsApp. A returning customer's name fills in from their number.
- **Payment** — Cash, UPI, Card and others; one bill can be split across several. Type the cash the customer gives: change shows in green. Nothing blocks saving. If the customer pays less, the bill saves with **Balance due** on it (and on the printed bill); the Bills list marks it **Balance**. To let a shortfall go instead, change the total.
- **Save & print** (or **F9**). Then **New bill** (or **Esc**). On a laptop set to **No printer**, the button says **Save** and nothing prints; send the bill with **Send on WhatsApp**.
- **Send on WhatsApp** on the saved bill opens WhatsApp with the bill as a message to the customer's number (it asks for the number if none was typed). Press **Send** in WhatsApp. WhatsApp links carry text only, so no PDF is sent. The first time, sign in to WhatsApp Web in that browser (scan the QR code with the shop's phone), or install WhatsApp for Windows.
- **Hold** (**F4**) parks a bill while you serve someone else, up to 3 per counter. Tap the held bill at the top to bring it back.
- **Custom box** puts loose items under one heading on the bill, for a box packed on the spot.

Keyboard: **F2** search · **F4** hold · **F8** payment · **F9** save & print · **Esc** new bill.

If an item is short in the shop, billing says exactly what's left. It never sells stock that isn't there, even when both counters bill the same item at the same moment.

### Bookings (orders with an advance)

- **Bookings → New booking:** customer, items, delivery date and the advance paid.
- On delivery day, on **Billing** press **Booking**, pick the customer, and the bill fills in with the advance already taken off. Collect the rest and save.
- **Changing the advance:** open the booking, press **Edit**, and change **Advance paid** and how it was paid. If the day it was taken isn't closed yet, it is simply corrected. Otherwise, extra money is recorded as paid today, and less is recorded as returned to the customer today.
- The dashboard lists bookings due today and tomorrow.

### Old bills, reprints and cancelling

- **Bills** — search by bill number, customer name or phone. Open a bill to reprint it (the reprint is marked DUPLICATE) or to **Send on WhatsApp** again. The Print view page has the same button.
- **Cancel bill** (owner only): give a reason. The items go back into stock and the cash shows as returned in the day's cash. Cancelled bills stay on record but never count in sales.

### Logging out

Press the log-out button next to your name at the bottom of the menu, whenever you leave the counter. The screen fades to a dark lock screen with the time. Tap it or press any key, then type a PIN to log in again.

### Moving stock (godown and shop)

- **Stock** shows what is in the shop and in the godown. Tick *Only low or out* to see what needs refilling.
- **Stock → Move stock:** pick *From* and *To* (the ⇄ button swaps them), add the items and quantities, then **Move stock**. Bills take stock from the shop, so move stock there from the godown before it runs out.
- Breakage, samples or counting differences (owner): **Stock check**. Record what you counted, or how many are damaged and why. Every change is kept in **History**.

### Purchases (owner)

Enter each supplier bill:
- the supplier and bill number
- where the stock goes (usually the Godown)
- transport charges
- each item's quantity and cost for one unit

Saving adds the stock. Transport is shared across the items by value, and each item's cost becomes the average of the old and new stock. The **Profit** report uses that cost.

### Evening — closing the day

Do this once for the whole shop, on either counter.

1. **Expenses & closing** — add the day's expenses (tea, labour, transport…), ticking whether they were paid from the drawer.
2. Count the drawer and type the amount. It shows straight away whether the cash matches, is short or is extra. Add a note if it doesn't match.
3. Enter how much cash was handed to the owner, then **Close the day**. This also makes a backup.
4. **Send summary on WhatsApp** sends the owner the day's sales, payment split, expenses and cash count.

### Owner's view

- **Dashboard**
  - Shows sales, money collected, best sellers and expenses for the dates you choose: **Today**, **Yesterday**, **7 days**, **30 days** or **Pick dates**.
  - The numbers are live, from both counters. Stock to refill and bookings due are always as of now, whatever the dates.
  - Staff see the dashboard too, but never profit.
  - **Back up now** is at the bottom.
- **Reports** — sales summary, product-wise, category-wise, profit (owner only) and daily summary, for any dates. **Download Excel** saves any report.
- **Settings → Activity log** shows who cancelled bills, changed an item's rate or the total on a bill, gave a discount other than the shop's usual (none unless the owner sets one), left a balance unpaid, moved stock and so on.

---

## Part 3 — When something goes wrong

| Problem | What to do |
| --- | --- |
| Counter 2 can't open billing | Check each of these: Is Counter 2 on the same Wi-Fi as the billing laptop? Is the black server window open on the billing laptop? Is the network set to **Private**? Was `allow_network.bat` run as administrator? Is Counter 2 using address 2 from the server window? |
| Bill didn't print | Is the printer on, with paper, and set as the **default** printer (not OneNote or Print to PDF)? Was billing opened with `open_billing.bat`? Is this laptop set to **Printer connected** (counter button at the bottom of the menu)? Press **Print again** on the saved bill, or reprint from **Bills**. |
| Staff forgot their PIN, or is locked out | Owner: **Settings → People & PINs**, set a new PIN. A wrong PIN 5 times locks for 5 minutes on its own. |
| Owner forgot their PIN | Another owner can reset it in Settings. Otherwise, on the billing laptop run `scripts\reset_pin.bat` and type the owner's name and a new PIN. |
| Billing window shows "screens are not built" | The `backend\frontend_dist` folder is missing. Copy the full software folder again. |

### Backups and restoring

Every backup is **two files** with the same name:

- an Excel file (`.xlsx`): open it in Excel to read the data without the app. It has the bills (with the items in each), stock with how much has sold, bookings and expenses.
- a database file (`.sqlite3`): the full backup, used to restore the app.

The name tells you which kind of backup it is:

- **Hourly**, for example `Hourly_2026-10-22_19-00.xlsx`. Made every hour from 7 AM to 10 PM while billing is on, and whenever you press **Back up now** (on the Dashboard or in Settings → Backup). Today's and yesterday's are kept.
- **Day**, for example `Day_2026-10-22.xlsx`. Made when the day is closed and again at 11 PM, so it always has the whole day. Day backups are kept all season. If the laptop was off at 11 PM and the day wasn't closed, the Day backup is made the next time billing starts.

Both kinds are saved on the billing laptop in `data\backups`, and copied to the Google Drive folder with product photos in a `media` folder beside them. Older files named `backup_<date>_<time>` stay where they are.

To restore a backup:

1. Close the black server window.
2. Double-click `scripts\restore_backup.bat`, pick a backup from the list (newest first), and type `YES` to confirm. To restore a file from Google Drive, drag that `.sqlite3` file (not the Excel file) onto `restore_backup.bat` instead.
3. Start billing again with `scripts\start_billing.bat`.

Before restoring, the current data is always saved as `data\backups\before-restore-<date>.sqlite3`. To undo a restore, drag that file onto `restore_backup.bat`.

**If the billing laptop itself is lost or dead:**
1. On the new laptop do Part 1 steps 1–4 only (Python, copy, install, network). Don't start or open billing yet.
2. Restore the newest `.sqlite3` file from the Google Drive folder (sort the folder by *Date modified*), as above.
3. Continue with step 5 onwards. Skip the set-up screen; it won't appear.
4. For product photos, copy the `media` folder from the Google Drive folder into `data\media`.

Everything up to that backup comes back, including people, PINs, stock and bills.

### Starting fresh (deleting everything)

To wipe the laptop's billing and start again as on a new install, for example after testing or before the season:

1. Double-click `scripts\clear_data.bat`. It lists everything that will be deleted:
   - people and PINs
   - shop settings
   - counters, and the Shop and Godown
   - products and all their stock
   - bills, bookings and customers
   - purchases and suppliers, stock moves
   - expenses and day closings
   - the activity log
2. Type `YES`. Everyone is logged out. Backups in `data\backups` and the Google Drive folder are not touched.
3. Press **F5** in billing on every counter. The **Set up this PC** screen appears, as in Part 1 step 6.
   - Create the owner and PIN, and choose the counter on each laptop.
   - Fill in **Settings** again, including the Google Drive folder under **Backup**, and add the staff.
   - Import the stock sheet on **Products**.
   - Bill and booking numbers start again from 1.

Billing can stay running while you do this. A copy of the data is saved first as `data\backups\before-clear-<date>.sqlite3`. To undo, close the black server window and drag that file onto `restore_backup.bat`.

---

## Still to confirm with the shop

These were not settled in the requirements. The software works with the defaults shown until the owner decides.

1. **Qty units in the stock sheet** — is one Qty a box or a piece (e.g. PoP PoP 7200)? Default: as typed, sold per "Box". Bundle sizes come from the sheet's *How many cases for a bundle* column.
2. **GST** — GSTIN, rate, HSN code, and whether prices include GST. GST invoices stay off until these are filled in. Estimates work now.
3. **Bill number format** — default `E-00001` (estimate), `G-…` (GST), `B-…` (booking).
4. **Gift boxes** — which items are in each box, and whether boxes are packed in advance (sold from stock) or packed per order (items taken from stock when sold).
5. **Cost prices** — needed for the profit report. Enter them in Products or through Purchases.
6. **WhatsApp** — bills open in WhatsApp for the staff to press Send. Fully automatic sending needs a WhatsApp Business API account (paid; not included).
7. **Delivery charge** for orders below ₹5,000 — not added yet.
8. **Bookings and stock** — a booking does not set stock aside today; stock is taken when the booking is billed.
9. **Discount** — new bills start with no discount, so items are billed at the sheet's Final Price. Anyone billing can still give any discount (no limit). The owner can set a starting discount in Settings → Bills & GST.
