from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from core.models import ShopSettings
from core.permissions import IsOwner

from .services import HOURLY, create_backup, list_local_backups, local_backup_dir, read_status


@api_view(["GET", "POST"])
@permission_classes([IsOwner])
def backups_view(request):
    shop = ShopSettings.get()
    status = create_backup("manual", kind=HOURLY) if request.method == "POST" else read_status()
    return Response(
        {
            "status": status,
            "local_folder": str(local_backup_dir()),
            "drive_folder": shop.backup_folder,
            "backups": list_local_backups(),
        },
        status=201 if request.method == "POST" else 200,
    )
