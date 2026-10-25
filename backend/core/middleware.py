import ipaddress
import socket

from django.conf import settings
from django.http import HttpResponseBadRequest
from django.http.request import split_domain_port


class LanHostMiddleware:
    """Only answer requests addressed to this PC on the local network.

    Accepts localhost, this computer's name, private (LAN) IP addresses and any
    names listed in SVC_EXTRA_HOSTS. Anything else is refused, which protects the
    app from DNS-rebinding tricks by websites opened on a counter's browser.
    """

    def __init__(self, get_response):
        self.get_response = get_response
        hostname = socket.gethostname().lower()
        self.names = {"localhost", hostname, f"{hostname}.local", "testserver"}
        self.names.update(getattr(settings, "EXTRA_ALLOWED_HOSTS", []))

    def is_allowed(self, host: str) -> bool:
        domain, _port = split_domain_port(host)
        if not domain:
            return False
        if domain in self.names:
            return True
        try:
            ip = ipaddress.ip_address(domain.strip("[]"))
        except ValueError:
            return False
        return ip.is_private or ip.is_loopback or ip.is_link_local

    def __call__(self, request):
        host = request.META.get("HTTP_HOST") or request.META.get("SERVER_NAME", "")
        if not self.is_allowed(host):
            return HttpResponseBadRequest("This billing app only works on the shop's local network.")
        return self.get_response(request)
