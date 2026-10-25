from django.db import transaction
from django.db.models import F

from .models import NumberSequence


def next_number(prefix: str, width: int = 5) -> str:
    """Next number for a prefix, e.g. "E-" -> "E-00042".

    Must run inside transaction.atomic(): SQLite IMMEDIATE transactions hold the
    write lock, so two counters can never get the same number.
    """
    if not transaction.get_connection().in_atomic_block:
        raise RuntimeError("next_number() must run inside transaction.atomic()")
    sequence, _ = NumberSequence.objects.get_or_create(key=prefix)
    NumberSequence.objects.filter(pk=sequence.pk).update(next_value=F("next_value") + 1)
    return f"{prefix}{sequence.next_value:0{width}d}"
