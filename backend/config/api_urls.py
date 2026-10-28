from django.urls import path

from backups import api as backups
from cash import api as cash
from catalog import api as catalog
from core import api as core
from inventory import api as inventory
from reports import api as reports
from sales import api as sales

urlpatterns = [
    path("bootstrap", core.bootstrap),
    path("license", core.license_view),
    path("setup", core.setup),
    path("auth/login", core.login_view),
    path("auth/logout", core.logout_view),
    path("auth/me", core.me_view),
    path("auth/pin", core.change_my_pin),
    path("settings", core.settings_view),
    path("users", core.users_view),
    path("users/<int:user_id>", core.user_detail),
    path("counters", core.counters_view),
    path("counters/<int:counter_id>", core.counter_detail),
    path("audit", core.audit_log),
    path("categories", catalog.categories_view),
    path("products", catalog.products_view),
    path("products/<int:product_id>", catalog.product_detail),
    path("products/<int:product_id>/photo", catalog.product_photo),
    path("products/<int:product_id>/box-items", catalog.gift_box_items),
    path("import/preview", catalog.import_preview),
    path("import/confirm", catalog.import_confirm),
    path("locations", inventory.locations_view),
    path("locations/<int:location_id>", inventory.location_detail),
    path("stock/movements", inventory.movements_view),
    path("stock/transfers", inventory.transfers_view),
    path("stock/adjustments", inventory.adjustments_view),
    path("suppliers", inventory.suppliers_view),
    path("suppliers/<int:supplier_id>", inventory.supplier_detail),
    path("purchases", inventory.purchases_view),
    path("bills", sales.bills_view),
    path("bills/<int:invoice_id>", sales.bill_detail),
    path("bills/<int:invoice_id>/cancel", sales.bill_cancel),
    path("bills/<int:invoice_id>/printed", sales.bill_printed),
    path("held-bills", sales.held_bills_view),
    path("held-bills/<int:held_id>", sales.held_bill_detail),
    path("customers", sales.customers_view),
    path("customers/<int:customer_id>", sales.customer_detail),
    path("bookings", sales.bookings_view),
    path("bookings/<int:booking_id>", sales.booking_detail),
    path("bookings/<int:booking_id>/payments", sales.booking_payment),
    path("bookings/<int:booking_id>/cancel", sales.booking_cancel),
    path("expenses", cash.expenses_view),
    path("expenses/<int:expense_id>", cash.expense_detail),
    path("day", cash.day_view),
    path("day/open", cash.day_open),
    path("day/close", cash.day_close),
    path("reports/<slug:kind>", reports.report_view),
    path("dashboard", reports.dashboard),
    path("backups", backups.backups_view),
]