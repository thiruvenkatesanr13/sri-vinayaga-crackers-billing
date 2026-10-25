# How to run Sri Vinayaga Crackers Billing

This file lists everything needed to get the billing software running on a Windows laptop: what to install, which scripts to run and in what order, and what to check if something doesn't work.

- Daily use (billing, stock, day closing, backups): [docs/OWNER_GUIDE.md](docs/OWNER_GUIDE.md)
- How the code works, for developers: [README.md](README.md)

## How it works

- **One laptop runs the software**: the billing laptop (Counter 1). It keeps all bills, stock and backups.
- **Other counters** open it in Chrome or Edge over the shop Wi-Fi. Nothing is installed on them.
- Billing works **without internet**. Internet is needed only once, while installing.

## 1. What you need

| What | Needed? | Notes |
| --- | --- | --- |
| Windows 10 or 11 laptop | Yes | The billing laptop. The screens are made for laptops (1280 pixels wide or more). |
| Python 3.13, 64-bit | Yes | Download the installer: https://www.python.org/ftp/python/3.13.17/python-3.13.17-amd64.exe (the version billing is tested on). Python 3.12, 3.14 and 3.15 also work. |
| Google Chrome or Microsoft Edge | Yes | Edge comes with Windows. |
| Internet | Once | Only while `install.bat` runs, to download the Python packages. |
| A second laptop on the same Wi-Fi | Optional | For Counter 2. Nothing to install on it. |
| 80 mm thermal receipt printer and its Windows driver | Optional | Without a printer, bills can be shown on screen instead. |
| Google Drive for Desktop | Optional | Keeps a copy of every backup outside the laptop. |
| Git, Node.js | No | Not needed to run billing: download the ZIP, and the screens come ready-built. Node.js 20.19+ only matters to someone who changes the screens' code. |

## 2. Put the folder on the billing laptop

1. Download it from https://github.com/thiruvenkatesanr13/sri-vinayaga-crackers-billing: green **Code** button → **Download ZIP** (or use the .zip file you were given).
2. Right-click the .zip → **Properties** → tick **Unblock** if it is shown → **OK**. Then right-click it → **Extract All**. Don't run anything from inside the zip.
3. Put the extracted folder at `C:\SriVinayagaBilling` (the folder from GitHub is called `sri-vinayaga-crackers-billing-main`; rename it). Not on the Desktop, in Downloads, OneDrive or the Google Drive folder: a sync program copying the database while it is open can damage it.
4. Check that the folder has `backend`, `scripts`, `docs` and `frontend`, and that `backend\frontend_dist` is there (the ready-built screens).
5. If you copied the folder from another laptop and it has `data`, `.venv` or `frontend\node_modules`, delete them. They belong to that PC, and `data` is that shop's own records.

## 3. Install (once)

1. Install Python: run the installer from the table above. On its first screen, tick **Add python.exe to PATH** (at the bottom), then click **Install Now**. Wait for **Setup was successful** and close it.
2. Double-click `scripts\install.bat` and wait for **Installed.** It takes a few minutes the first time. It creates the Python environment (`.venv`), installs the packages and creates the empty database.
3. Only if Counter 2 will connect:
   - Windows Settings → Network & internet → the shop Wi-Fi → set **Network profile type** to **Private**.
   - Right-click `scripts\allow_network.bat` → **Run as administrator**.
4. Double-click `scripts\setup_autostart.bat`. Billing then starts by itself whenever the laptop is switched on and someone logs in to Windows.

If Windows shows "Windows protected your PC" when you run a script, click **More info** → **Run anyway**.

## 4. Start billing and set up the shop

1. Double-click `scripts\start_billing.bat`. A black window opens and shows two addresses, for example:

   ```
   1. On this PC:      http://localhost:8000
   2. Other counters:  http://192.168.1.20:8000
   ```

   **Keep this window open** (you can minimise it). Closing it stops billing. If billing stops by itself, the window starts it again after 10 seconds.
2. Double-click `scripts\open_billing.bat`. Billing opens in its own window. Put a shortcut to this file on the desktop.
3. The first time, **Set up this PC** appears. Type the owner's name and a 6–8 digit PIN. This also creates Counter 1, Counter 2, the Shop and the Godown. Choose **Counter 1** when asked.
4. In **Settings** (owner), fill in the shop details (name, phones, address, the lines at the bottom of the bill), bill numbers and GST, and add staff under **People & PINs** (4–8 digit PINs).
5. In **Products → Import from Excel**, choose the stock sheet and where that stock is (Shop or Godown). The sheet's columns are Sparkle, QTY Removed, Qty Add, How many cases for a bundle and Final Price, with each category name on its own row. Details are in [docs/OWNER_GUIDE.md](docs/OWNER_GUIDE.md), step 8.

## 5. Counter 2 (optional)

1. Connect the second laptop to the same Wi-Fi.
2. Copy the `scripts` folder to it.
3. Make a desktop shortcut to `open_billing.bat` and add address 2 after the file name, for example `open_billing.bat http://192.168.1.20:8000`.
4. Log in and choose **Counter 2**.

Ask whoever manages the Wi-Fi router to give the billing laptop a fixed address (a "DHCP reservation"), so address 2 doesn't change after a restart.

## 6. Bill printer (optional)

- Install the 80 mm printer's driver and make it the **default printer** in Windows. Always open billing with `open_billing.bat`: bills then print straight away, with no print dialog.
- On a laptop with no printer, click the counter button at the bottom of the menu and choose **Show bills on screen**.

## 7. Backups

- They are made automatically while billing runs:
  - `Hourly_<date>_<time>` every hour from 7 AM to 10 PM, kept for 2 days.
  - `Day_<date>` when the day is closed and at 11 PM, kept all season.
- Each backup is two files: an Excel file to read, and a database file to restore from. They are saved in `data\backups`.
- For a copy outside the laptop, install Google Drive for Desktop and choose a Drive folder in **Settings → Backup**.
- To restore one, close the black window and run `scripts\restore_backup.bat`.

## 8. The scripts

All scripts are in the `scripts` folder.

| Script | What it does |
| --- | --- |
| `install.bat` | Installs the software. Run it once, and again after copying in a new version. |
| `allow_network.bat` | Lets other counters on the shop Wi-Fi connect. Run as administrator. |
| `start_billing.bat` | Starts billing. Keep its window open. |
| `setup_autostart.bat` | Starts billing whenever the laptop is switched on. |
| `open_billing.bat` | Opens billing in its own window, printing straight to the default printer. |
| `backup_now.bat` | Makes a backup now. |
| `restore_backup.bat` | Puts back the data from a backup. |
| `reset_pin.bat` | Sets a new PIN when someone forgets theirs. |
| `clear_data.bat` | Fresh start: deletes everything (people, PINs, settings, products, stock, bills…) so billing starts again from the Set up screen. Backups stay. |
| `build_frontend.bat` | For developers: rebuilds the screens after changing their code. |

## 9. If something doesn't work

| Problem | What to do |
| --- | --- |
| `install.bat` says Python 3.12 or newer is not installed | Install Python 3.13 from the link in step 1, with **Add python.exe to PATH** ticked, then run `install.bat` again. |
| `install.bat` fails while downloading | Check the internet connection and run it again. |
| "The screens are missing" or "The screens are not built" | `backend\frontend_dist` is missing. Copy the full project folder again. |
| "Billing is already running on this PC" | It is already running. Just open billing with `open_billing.bat`. |
| Billing doesn't open | Is the black `start_billing.bat` window open? |
| Counter 2 can't connect | Is it on the same Wi-Fi? Is the black window open on the billing laptop? Is the network set to Private? Was `allow_network.bat` run as administrator? Is Counter 2 using address 2? |
| Bills don't print | Is the 80 mm printer the Windows default printer (not OneNote or Microsoft Print to PDF)? Was billing opened with `open_billing.bat`? |
| Someone forgot their PIN | The owner sets a new one in **Settings → People & PINs**. For the owner's own PIN, run `scripts\reset_pin.bat` on the billing laptop. |

More help is in [docs/OWNER_GUIDE.md](docs/OWNER_GUIDE.md), Part 3.

## 10. Sharing this project with someone else

Send them the link: https://github.com/thiruvenkatesanr13/sri-vinayaga-crackers-billing. The repository holds only what is needed to run billing, never a shop's data.

If you copy the folder from a laptop instead, leave out:

- `data`: that shop's own bills, stock, PINs and backups. Keep it private.
- `.venv` and `frontend\node_modules`: the install scripts make them on each PC, and they are large.

Keep `backend\frontend_dist`. It holds the ready-built screens, so the other laptop doesn't need Node.js.

### Trying it on a Mac or Linux

The `.bat` scripts are for Windows, and the shop setup is Windows only. To just try billing on a Mac or Linux with Python 3.12+, run these three commands in the project folder, then open http://localhost:8000:

```
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
.venv/bin/python backend/serve.py
```