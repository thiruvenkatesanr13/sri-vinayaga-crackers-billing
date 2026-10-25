from django.conf import settings
from django.urls import include, path, re_path
from django.views.static import serve

from core.spa import spa_index

urlpatterns = [
    path("api/", include("config.api_urls")),
    re_path(r"^media/(?P<path>.*)$", serve, {"document_root": settings.MEDIA_ROOT}),
    re_path(r"^(?!api/|media/|assets/).*$", spa_index),
]
