"""Backups to this PC and to a Google Drive folder, in two kinds you can tell apart by name.

    Hourly_2026-10-22_19-00.xlsx / .sqlite3   every hour while billing is on, and Back up now.
                                              Kept for 2 days.
    Day_2026-10-22.xlsx / .sqlite3            the day's backup: made at Close the day and again
                                              at 11 PM. Kept all season.

Each backup is two files with the same name: the Excel file to open and read, and the
database file that restore_backup puts back. They are kept on this PC (data/backups) and
copied into the Google Drive folder set in Settings, which Google Drive for Desktop
uploads, so no Google API keys are needed. Product photos go into a "media" folder there.
Older backups named backup_<date>_<time> are left as they are.
"""

import json
import logging
import os
import re
import shutil
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from django.conf import settings
from django.db.models import Max
from django.utils import timezone

from core.models import ShopSettings

from .excel import write_backup_excel

log = logging.getLogger(__name__)

_backup_lock = threading.Lock()

HOURLY, DAY = "hourly", "day"
NAME = re.compile(
    r"^(?:Hourly_(?P<hour_day>\d{4}-\d{2}-\d{2})_\d{2}-\d{2}"
    r"|Day_(?P<day>\d{4}-\d{2}-\d{2})"
    r"|backup_(?P<old_day>\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2})$"
)


def data_dir() -> Path:
    return Path(settings.DATA_DIR)


def local_backup_dir() -> Path:
    return data_dir() / "backups"


def db_path() -> Path:
    return Path(settings.DATABASES["default"]["NAME"])


def _write_json(path: Path, data: dict) -> None:
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    os.replace(temp, path)


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def status_path() -> Path:
    return local_backup_dir() / "status.json"


def read_status() -> dict:
    return _read_json(status_path()) or {}


def read_only_uri(path: Path) -> str:
    return f"{path.resolve().as_uri()}?mode=ro"


def snapshot_database(source: Path, target: Path) -> None:
    """Consistent copy of a live SQLite database (safe while bills are being saved)."""
    if target.exists():
        target.unlink()
    src = sqlite3.connect(str(source), timeout=30)
    try:
        dst = sqlite3.connect(str(target))
        try:
            src.backup(dst)
            # A single self-contained file: no -wal/-shm files needed to read it.
            dst.execute("PRAGMA journal_mode=DELETE")
        finally:
            dst.close()
    finally:
        src.close()
    check_database(target)


def check_database(path: Path) -> None:
    conn = sqlite3.connect(read_only_uri(path), uri=True)
    try:
        result = conn.execute("PRAGMA integrity_check").fetchone()[0]
        conn.execute("SELECT shop_name FROM core_shopsettings").fetchall()
    finally:
        conn.close()
    if result != "ok":
        raise RuntimeError(f"Backup check failed: {result}")


def backup_stem(kind: str, moment: datetime, day: date | None = None) -> str:
    """Hourly_2026-10-22_19-00 or Day_2026-10-22: one name for the Excel file and the database file."""
    if kind == DAY:
        return f"Day_{(day or timezone.localtime(moment).date()).isoformat()}"
    return f"Hourly_{timezone.localtime(moment):%Y-%m-%d_%H-%M}"


def backup_kind(stem: str) -> str | None:
    match = NAME.match(stem)
    if not match:
        return None
    return HOURLY if match["hour_day"] else DAY if match["day"] else "older"


def _replace(part: Path, final: Path, tries: int = 3) -> None:
    """Replace a file that may be open for a moment (Google Drive uploading it, or Excel)."""
    for attempt in range(tries):
        try:
            os.replace(part, final)
            return
        except PermissionError:
            if attempt == tries - 1:
                part.unlink(missing_ok=True)
                raise PermissionError(f"{final.name} is open in another program, so it was not updated. Close it.")
            time.sleep(1)


def _copy_into(source: Path, folder: Path) -> None:
    part = folder / f"{source.name}.part"
    shutil.copyfile(source, part)
    _replace(part, folder / source.name)


def _prune(folder: Path, today: date) -> None:
    """Hourly backups are kept for HOURLY_BACKUP_DAYS days (today counts as one). Day backups are kept."""
    oldest = today - timedelta(days=settings.HOURLY_BACKUP_DAYS - 1)
    for file in folder.glob("Hourly_*"):
        match = NAME.match(file.name.split(".")[0])
        if match and match["hour_day"] and date.fromisoformat(match["hour_day"]) < oldest:
            try:
                file.unlink()
            except OSError:
                log.warning("Could not remove old backup %s", file)


def _sync_media(target: Path) -> None:
    source = Path(settings.MEDIA_ROOT)
    if not source.exists():
        return
    for file in source.rglob("*"):
        if not file.is_file():
            continue
        dest = target / file.relative_to(source)
        if dest.exists() and dest.stat().st_size == file.stat().st_size:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, dest)


def create_backup(reason: str = "manual", kind: str = HOURLY, day: date | None = None) -> dict:
    """Back up the shop's data on this PC and, if set up, to Google Drive.

    kind is "hourly" (every hour and Back up now) or "day" (the day's backup, named after
    `day`, today by default). A backup with a name that already exists replaces it.
    """
    if kind not in (HOURLY, DAY):
        raise ValueError(f"Unknown backup kind: {kind}")
    with _backup_lock:
        shop = ShopSettings.get()
        now = timezone.now()
        today = timezone.localdate()
        stem = backup_stem(kind, now, day)
        folder = local_backup_dir()
        folder.mkdir(parents=True, exist_ok=True)
        final = folder / f"{stem}.sqlite3"
        part = folder / f"{final.name}.part"
        snapshot_database(db_path(), part)
        _replace(part, final)

        status = read_status()
        excel = folder / f"{stem}.xlsx"
        excel_part = folder / f"{excel.name}.part"
        title = f"Day backup for {(day or today):%d-%m-%Y}" if kind == DAY else "Hourly backup"
        try:
            write_backup_excel(final, excel_part, timezone.localtime(now), title)
            _replace(excel_part, excel)
            status["excel_error"] = None
        except Exception as exc:  # noqa: BLE001 - the database copy above is the backup that matters
            log.exception("Excel copy of the backup failed")
            excel_part.unlink(missing_ok=True)
            excel = None
            status["excel_error"] = str(exc)
        _prune(folder, today)

        status.update(
            last_local_at=now.isoformat(),
            last_local_file=final.name,
            last_local_excel=excel.name if excel else None,
            last_kind=kind,
            last_reason=reason,
        )
        if kind == DAY:
            status.update(last_day_at=now.isoformat(), last_day_file=final.name)
        else:
            status.update(last_hourly_at=now.isoformat())
        drive = shop.backup_folder.strip()
        status["drive_configured"] = bool(drive)
        if drive:
            try:
                target = Path(drive)
                if not target.is_dir():
                    raise FileNotFoundError(f"Google Drive folder not found: {drive}")
                _copy_into(final, target)
                problem = None
                if excel:
                    try:
                        _copy_into(excel, target)
                    except PermissionError as exc:
                        problem = str(exc)
                _prune(target, today)
                _sync_media(target / "media")
                status.update(last_drive_at=now.isoformat(), drive_error=problem)
            except Exception as exc:  # noqa: BLE001 - reported to the owner on the dashboard
                log.exception("Google Drive backup failed")
                status.update(drive_error=str(exc), drive_error_at=now.isoformat())
        _write_json(status_path(), status)
        return status


def missed_day() -> date | None:
    """The last day with any bills, payments or expenses before today, when it has no Day backup yet.

    Billing starts with this check, so a day still gets its Day backup when the laptop
    was switched off before 11 PM without closing the day.
    """
    from cash.models import DaySession, Expense
    from sales.models import Invoice, Payment

    today = timezone.localdate()
    days = [
        model.objects.filter(business_date__lt=today).aggregate(last=Max("business_date"))["last"]
        for model in (Invoice, Payment, Expense, DaySession)
    ]
    last = max((d for d in days if d), default=None)
    if last is None or (local_backup_dir() / f"{backup_stem(DAY, timezone.now(), last)}.sqlite3").exists():
        return None
    return last


def list_local_backups(limit: int = 40) -> list[dict]:
    """Newest first. Each entry is one backup: its database file plus the Excel file of the same name."""
    found = []
    for db in local_backup_dir().glob("*.sqlite3"):
        kind = backup_kind(db.stem)
        if kind is None:
            continue
        excel = db.with_suffix(".xlsx")
        stat = db.stat()
        found.append(
            {
                "file": db.name,
                "kind": kind,
                "size": stat.st_size,
                "excel": excel.name if excel.exists() else None,
                "excel_size": excel.stat().st_size if excel.exists() else None,
                "taken_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.get_current_timezone()).isoformat(),
                "_mtime": stat.st_mtime,
            }
        )
    found.sort(key=lambda entry: entry["_mtime"], reverse=True)
    for entry in found:
        del entry["_mtime"]
    return found[:limit]
