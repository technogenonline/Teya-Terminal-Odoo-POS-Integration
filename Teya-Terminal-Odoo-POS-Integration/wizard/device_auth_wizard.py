import requests

from odoo import _, fields, models
from odoo.exceptions import UserError

from ..models.pos_payment_method_taplink import _taplink_api_error_message
from ..models.taplink_partner_credentials import (
    resolve_taplink_client_id,
    resolve_taplink_client_secret,
)


class TaplinkDeviceAuthWizard(models.TransientModel):
    _name = "taplink.device.auth.wizard"
    _description = "Teya device authorization"

    qr_code = fields.Binary(string="QR Code", readonly=True)
    verification_uri = fields.Char(string="Verification Uri")
    device_code = fields.Char(string="Device Code")
    payment_method_id = fields.Many2one("pos.payment.method", string="Payment Method")

    def action_confirm_device_authorization(self):
        url = self.payment_method_id._taplink_device_oauth_base_url()
        auth_device_url = url + "/oauth-token"
        device_code = self.device_code
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        auth_payload = (
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"
            f"&device_code={device_code}"
            f"&client_id={resolve_taplink_client_id()}"
            f"&client_secret={resolve_taplink_client_secret()}"
        )

        try:
            response = requests.request("POST", auth_device_url, headers=headers, data=auth_payload, timeout=30)
        except requests.RequestException as error:
            raise UserError(_("Could not connect to Teya: %s", error)) from error

        if response.status_code != 200:
            raise UserError(
                _(
                    "Teya device verification failed (HTTP %s): %s",
                    response.status_code,
                    _taplink_api_error_message(response),
                )
            )

        tokens = {
            "taplink_access_token": response.json().get("access_token"),
            "taplink_refresh_token": response.json().get("refresh_token"),
        }
        payment_method = self.payment_method_id
        payment_method.write(tokens)
        payment_method._taplink_propagate_tokens_same_mode(tokens)

        return {"type": "ir.actions.act_window_close"}
