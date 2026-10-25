"""Error types for business rules and a consistent JSON error shape.

Every error response looks like {"detail": "...", "code": "...", ...extra}.
"""

from rest_framework import status
from rest_framework.exceptions import APIException, ValidationError
from rest_framework.views import exception_handler as drf_exception_handler


class BusinessError(APIException):
    status_code = status.HTTP_400_BAD_REQUEST
    default_code = "invalid"

    def __init__(self, message: str, code: str | None = None, status_code: int | None = None, **extra):
        self.message = message
        self.code = code or self.default_code
        if status_code:
            self.status_code = status_code
        self.extra = extra
        super().__init__(detail=message, code=self.code)


class ConflictError(BusinessError):
    """Something changed under us (stock sold by another counter, prices changed)."""

    status_code = status.HTTP_409_CONFLICT
    default_code = "conflict"


def _flatten_validation(detail) -> str:
    if isinstance(detail, dict):
        for key, value in detail.items():
            text = _flatten_validation(value)
            if text:
                return text if key in ("non_field_errors", "detail") else f"{key}: {text}"
        return ""
    if isinstance(detail, list):
        for item in detail:
            text = _flatten_validation(item)
            if text:
                return text
        return ""
    return str(detail)


def exception_handler(exc, context):
    if isinstance(exc, BusinessError):
        from rest_framework.response import Response

        body = {"detail": exc.message, "code": exc.code, **exc.extra}
        return Response(body, status=exc.status_code)

    response = drf_exception_handler(exc, context)
    if response is None:
        return None
    if isinstance(exc, ValidationError):
        response.data = {
            "detail": _flatten_validation(exc.detail) or "Please check the form.",
            "code": "invalid",
            "fields": exc.detail,
        }
    elif isinstance(response.data, dict) and "detail" in response.data:
        response.data = {"detail": str(response.data["detail"]), "code": getattr(exc, "default_code", "error")}
    return response
