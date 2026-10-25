from collections import defaultdict

from django.db import migrations, models


def opening_stock_counts_as_imported(apps, schema_editor):
    """Items brought in by the earlier import had their Qty added as opening stock.
    Note it as the sheet's Qty Add, so importing the new sheet does not add it again."""
    Product = apps.get_model("catalog", "Product")
    StockMovement = apps.get_model("inventory", "StockMovement")
    totals = defaultdict(int)
    for product_id, change in StockMovement.objects.filter(reason="opening", ref_type="import").values_list(
        "product_id", "change"
    ):
        totals[product_id] += change
    for product in Product.objects.filter(pk__in=totals):
        product.import_last = {"added": totals[product.pk], "removed": 0}
        product.save(update_fields=["import_last"])


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0002_initial"),
        ("inventory", "0003_stock_sheet_reasons"),
    ]

    operations = [
        migrations.AddField(
            model_name="product",
            name="import_last",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AlterField(
            model_name="importbatch",
            name="file_sha256",
            field=models.CharField(db_index=True, max_length=64),
        ),
        migrations.RunPython(opening_stock_counts_as_imported, migrations.RunPython.noop),
    ]
