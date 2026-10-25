"""Settings for the Sri Vinayaga Crackers billing app.

The app runs on the shop's billing laptop; the other counter opens it over the
shop Wi-Fi. All writable data (database, photos, backups, logs, secret key)
lives in DATA_DIR, outside the code.
"""

import os
import secrets
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BASE_DIR.parent
TESTING = len(sys.argv) > 1 and sys.argv[1] == "test"
DATA_DIR = Path(os.environ.get("SVC_DATA_DIR", PROJECT_DIR / "data")).resolve()
if TESTING:
    DATA_DIR = DATA_DIR / "test-run"
for _sub in ("", "media", "backups", "logs", "imports", "staticfiles"):
    (DATA_DIR / _sub).mkdir(parents=True, exist_ok=True)


def _secret_key() -> str:
    env_key = os.environ.get("SVC_SECRET_KEY")
    if env_key:
        return env_key
    key_file = DATA_DIR / "secret_key.txt"
    if key_file.exists():
        return key_file.read_text(encoding="utf-8").strip()
    key = secrets.token_urlsafe(50)
    key_file.write_text(key, encoding="utf-8")
    return key


SECRET_KEY = _secret_key()
DEBUG = os.environ.get("SVC_DEBUG") == "1"

# Host names are checked by core.middleware.LanHostMiddleware, which only
# allows localhost, this PC's name and private (LAN) IP addresses.
ALLOWED_HOSTS = ["*"]
EXTRA_ALLOWED_HOSTS = [h.strip().lower() for h in os.environ.get("SVC_EXTRA_HOSTS", "").split(",") if h.strip()]

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.staticfiles",
    "rest_framework",
    "core",
    "catalog",
    "inventory",
    "sales",
    "cash",
    "reports",
    "backups",
]

MIDDLEWARE = [
    "core.middleware.LanHostMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": ["django.template.context_processors.request"]},
    }
]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": DATA_DIR / "db.sqlite3",
        "OPTIONS": {
            # Each write transaction takes the write lock up front, so several
            # counters saving at once queue up instead of failing.
            "transaction_mode": "IMMEDIATE",
            "timeout": 20,
            "init_command": (
                "PRAGMA journal_mode=WAL;"
                "PRAGMA synchronous=FULL;"
                "PRAGMA busy_timeout=20000;"
            ),
        },
        # File-based test database so multi-counter tests use real locking.
        "TEST": {"NAME": str(DATA_DIR / "test_db.sqlite3")},
    }
}

AUTH_USER_MODEL = "core.User"
if TESTING:
    PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

LANGUAGE_CODE = "en-in"
TIME_ZONE = "Asia/Kolkata"
USE_I18N = False
USE_TZ = True

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# React build output (frontend/ is built into backend/frontend_dist).
FRONTEND_DIST = BASE_DIR / "frontend_dist"
STATIC_URL = "/static/"
STATIC_ROOT = DATA_DIR / "staticfiles"
if FRONTEND_DIST.exists():
    WHITENOISE_ROOT = FRONTEND_DIST
WHITENOISE_IMMUTABLE_FILE_TEST = r"^.+[.-][0-9a-zA-Z_-]{8,12}\..+$"

MEDIA_URL = "/media/"
MEDIA_ROOT = DATA_DIR / "media"

DATA_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024

SESSION_COOKIE_NAME = "svc_session"
SESSION_COOKIE_AGE = 60 * 60 * 14
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
X_FRAME_OPTIONS = "DENY"
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": [
        "rest_framework.parsers.JSONParser",
        "rest_framework.parsers.MultiPartParser",
    ],
    "EXCEPTION_HANDLER": "core.errors.exception_handler",
    "URL_FORMAT_OVERRIDE": None,
}

# Lock a user out for a while after this many wrong PINs in a row.
PIN_MAX_ATTEMPTS = 5
PIN_LOCK_MINUTES = 5

# Automatic backups while the server is running (see serve.py): an Hourly backup every
# hour from 7 AM to 10 PM and the Day backup at 11 PM. SVC_AUTO_BACKUP=0 turns them off.
AUTO_BACKUP = os.environ.get("SVC_AUTO_BACKUP", "1") != "0"
# Hourly backups are kept this many days (today counts as one); Day backups are kept.
HOURLY_BACKUP_DAYS = 2

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"plain": {"format": "%(asctime)s %(levelname)s %(name)s: %(message)s"}},
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "plain"},
        "file": {
            "class": "logging.handlers.RotatingFileHandler",
            "filename": str(DATA_DIR / "logs" / "app.log"),
            "maxBytes": 2 * 1024 * 1024,
            "backupCount": 5,
            "encoding": "utf-8",
            "formatter": "plain",
        },
    },
    "root": {"handlers": ["console", "file"], "level": "INFO"},
    "loggers": {"django.db.backends": {"level": "WARNING"}},
}
