from rest_framework.permissions import SAFE_METHODS, BasePermission


def is_owner(user) -> bool:
    return bool(user and user.is_authenticated and getattr(user, "role", None) == "owner")


class IsOwner(BasePermission):
    message = "Only the owner can do this."

    def has_permission(self, request, view):
        return is_owner(request.user)


class OwnerWriteStaffRead(BasePermission):
    """Everyone logged in can read; only the owner can change."""

    message = "Only the owner can change this."

    def has_permission(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return False
        if request.method in SAFE_METHODS:
            return True
        return is_owner(request.user)
