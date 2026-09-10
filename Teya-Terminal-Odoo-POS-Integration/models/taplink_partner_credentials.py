# -*- coding: utf-8 -*-
import base64

from odoo import _
from odoo.exceptions import UserError

from . import taplink_partner_secrets as _secrets
from .taplink_secret_padding import HEAD_TRIM, TAIL_TRIM


def _decode_wrapped_credential(wrapped_value):
    """Drop fixed leading/trailing noise; return value used for Teya OAuth."""
    if not wrapped_value:
        raise UserError(_("Payment terminal partner settings are missing. Contact your provider."))
    minimum = HEAD_TRIM + TAIL_TRIM + 1
    if len(wrapped_value) < minimum:
        raise UserError(_("Payment terminal partner settings are invalid. Contact your provider."))
    if TAIL_TRIM:
        core = wrapped_value[HEAD_TRIM:-TAIL_TRIM]
    else:
        core = wrapped_value[HEAD_TRIM:]
    if not core or not core.strip():
        raise UserError(_("Payment terminal partner settings are invalid. Contact your provider."))
    return core


def resolve_taplink_client_id():
    return _decode_wrapped_credential(_secrets.TAPLINK_CLIENT_KEY_WRAPPED)


def resolve_taplink_client_secret():
    return _decode_wrapped_credential(_secrets.TAPLINK_CLIENT_SECRET_WRAPPED)


def build_taplink_basic_auth_header():
    credentials = f"{resolve_taplink_client_id()}:{resolve_taplink_client_secret()}"
    encoded = base64.b64encode(credentials.encode()).decode()
    return f"Basic {encoded}"
