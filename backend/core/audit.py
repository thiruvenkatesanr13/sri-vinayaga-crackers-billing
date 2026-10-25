from .models import AuditLog


def audit(user, action: str, summary: str = "", obj=None, **details) -> AuditLog:
    """Record a sensitive action. Never pass PINs or tokens in details."""
    return AuditLog.objects.create(
        user=user if getattr(user, "is_authenticated", False) else None,
        user_name=getattr(user, "display_name", "") or "",
        action=action,
        object_type=obj.__class__.__name__ if obj is not None else "",
        object_id=str(obj.pk) if obj is not None and obj.pk is not None else "",
        summary=summary[:300],
        details=details,
    )
