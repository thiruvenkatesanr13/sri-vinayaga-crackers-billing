from django.conf import settings
from django.http import HttpResponse
from django.views.decorators.csrf import ensure_csrf_cookie


@ensure_csrf_cookie
def spa_index(request, *args, **kwargs):
    """Serve the React app for every page route (the browser handles routing)."""
    index = settings.FRONTEND_DIST / "index.html"
    if not index.exists():
        return HttpResponse(
            "The screens are not built yet. Run scripts\\build_frontend.bat once, then reload.",
            content_type="text/plain; charset=utf-8",
            status=503,
        )
    response = HttpResponse(index.read_bytes(), content_type="text/html; charset=utf-8")
    response["Cache-Control"] = "no-cache"
    return response
