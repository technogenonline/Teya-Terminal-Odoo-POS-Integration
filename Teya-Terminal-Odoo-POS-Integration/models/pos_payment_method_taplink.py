import base64
import logging

import requests

from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError

from .taplink_partner_credentials import (
    build_taplink_basic_auth_header,
    resolve_taplink_client_id,
    resolve_taplink_client_secret,
)

_logger = logging.getLogger(__name__)


def _taplink_api_error_message(response):
    try:
        body = response.json()
    except (ValueError, requests.exceptions.JSONDecodeError):
        return (response.text or response.reason or "")[:500]
    if isinstance(body, dict):
        error = body.get("error")
        if error == "invalid_client":
            desc = body.get("error_description") or body.get("message")
            return _(
                "Teya rejected the integration credentials (invalid_client). "
                "Contact your provider to update OAuth client settings."
            ) + (f" {desc}" if desc else "")
        return (
            body.get("error_description")
            or body.get("detail")
            or body.get("message")
            or body.get("description")
            or body.get("title")
            or str(body)
        )
    return str(body)


class PosPaymentMethod(models.Model):
    _inherit = "pos.payment.method"

    def _taplink_bearer_authorization(self):
        token = self.taplink_access_token
        if not token:
            raise UserError(
                _(
                    "No Teya access token on this payment method. "
                    "Click Generate Token, complete device authorization, then try Sync outlets again."
                )
            )
        return f"Bearer {token}"

    def _get_payment_terminal_selection(self):
        return super()._get_payment_terminal_selection() + [("taplink", "Teya")]

    @api.model
    def _load_pos_data_fields(self, config_id):
        fields_list = super()._load_pos_data_fields(config_id)
        if not fields_list:
            return fields_list
        extra = ["taplink_outlet_id", "taplink_reader_id"]
        return fields_list + [f for f in extra if f not in fields_list]

    taplink_runtime_mode = fields.Selection(
        [("production", "Production"), ("test", "Sandbox")],
        string="Payment Mode",
        default="production",
    )
    taplink_access_token = fields.Char(string="Access token")
    taplink_refresh_token = fields.Char(string="Refresh token")
    taplink_outlet_id = fields.Many2one("taplink.merchant.outlet", string="Store")
    taplink_reader_id = fields.Many2one(
        "taplink.card.reader",
        string="Card reader",
        domain="[('outlet_id', '=', taplink_outlet_id)]",
        help="Card terminal used for this payment method. Run Sync outlets to refresh the list.",
    )

    def _is_write_forbidden(self, fields):
        whitelisted_fields = {"sequence", "taplink_access_token", "taplink_refresh_token"}
        return bool(fields - whitelisted_fields and self.open_session_ids)

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get("use_payment_terminal") == "taplink":
                vals.setdefault("taplink_runtime_mode", "production")
        return super().create(vals_list)

    def write(self, vals):
        if vals.get("use_payment_terminal") == "taplink":
            vals.setdefault("taplink_runtime_mode", "production")
        return super().write(vals)

    @api.onchange("use_payment_terminal")
    def _onchange_use_payment_terminal(self):
        super()._onchange_use_payment_terminal()
        if self.use_payment_terminal:
            self.payment_method_type = "terminal"
        if self.use_payment_terminal == "taplink" and not self.taplink_runtime_mode:
            self.taplink_runtime_mode = "production"

    @api.onchange("taplink_outlet_id")
    def _onchange_taplink_outlet_id(self):
        if self.taplink_reader_id and self.taplink_reader_id.outlet_id != self.taplink_outlet_id:
            self.taplink_reader_id = False

    @api.constrains("taplink_reader_id", "taplink_outlet_id", "use_payment_terminal")
    def _check_taplink_reader_outlet(self):
        for payment_method in self:
            if payment_method.use_payment_terminal != "taplink":
                continue
            if (
                payment_method.taplink_reader_id
                and payment_method.taplink_outlet_id
                and payment_method.taplink_reader_id.outlet_id != payment_method.taplink_outlet_id
            ):
                raise ValidationError(
                    _(
                        "The selected card reader does not belong to outlet %s.",
                        payment_method.taplink_outlet_id.name,
                    )
                )

    def _taplink_resolve_card_reader(self, pos_config):
        """Reader configured on this Teya payment method."""
        self.ensure_one()
        reader = self.taplink_reader_id
        if not reader:
            raise UserError(
                _(
                    "No card reader is configured on payment method “%(method)s”. "
                    "Open the payment method, choose Store and Card reader, then try again.",
                    method=self.display_name,
                )
            )
        if not self.taplink_outlet_id:
            raise UserError(
                _(
                    "No merchant outlet is configured on payment method “%(method)s”. "
                    "Click Sync outlets on the payment method, then select a store and reader.",
                    method=self.display_name,
                )
            )
        if reader.outlet_id and reader.outlet_id != self.taplink_outlet_id:
            raise UserError(
                _(
                    "Card reader “%(reader)s” is not linked to outlet “%(outlet)s” on payment method “%(method)s”.",
                    reader=reader.display_name,
                    outlet=self.taplink_outlet_id.name,
                    method=self.display_name,
                )
            )
        return reader

    def _taplink_oauth_token_url(self):
        self.ensure_one()
        if self.taplink_runtime_mode == "test":
            return "https://id.teya.xyz/oauth/v2/oauth-token"
        return "https://id.teya.com/oauth/v2/oauth-token"

    def _taplink_request_refresh_tokens(self):
        """Refresh OAuth tokens for this payment method. Returns token dict or None."""
        self.ensure_one()
        if not self.taplink_refresh_token:
            return None
        payload = f"refresh_token={self.taplink_refresh_token}&grant_type=refresh_token"
        headers = {
            "Authorization": build_taplink_basic_auth_header(),
            "Content-Type": "application/x-www-form-urlencoded",
        }
        try:
            response = requests.request(
                "POST",
                self._taplink_oauth_token_url(),
                headers=headers,
                data=payload,
                timeout=30,
            )
        except requests.RequestException as error:
            _logger.warning(
                "Taplink token refresh failed for %s: %s",
                self.display_name,
                error,
            )
            return None
        if response.status_code != 200:
            _logger.warning(
                "Taplink token refresh failed for %s (HTTP %s): %s",
                self.display_name,
                response.status_code,
                _taplink_api_error_message(response),
            )
            return None
        body = response.json()
        access = body.get("access_token")
        refresh = body.get("refresh_token")
        if not access or not refresh:
            _logger.warning(
                "Taplink token refresh for %s returned incomplete payload.",
                self.display_name,
            )
            return None
        return {"taplink_access_token": access, "taplink_refresh_token": refresh}

    def _taplink_propagate_tokens_same_mode(self, tokens):
        """Same merchant OAuth covers all readers; copy tokens to sibling payment methods."""
        self.ensure_one()
        if not tokens:
            return
        mode = self.taplink_runtime_mode or "production"
        siblings = self.sudo().search(
            [
                ("use_payment_terminal", "=", "taplink"),
                ("taplink_runtime_mode", "=", mode),
                ("id", "!=", self.id),
            ]
        )
        if siblings:
            siblings.write(tokens)

    @api.model
    def _cron_taplink_refresh_oauth_tokens(self):
        """Refresh OAuth for every Taplink payment method (all linked readers)."""
        payment_methods = self.sudo().search([("use_payment_terminal", "=", "taplink")])
        if not payment_methods:
            return

        seen_refresh_keys = set()
        latest_tokens_by_mode = {}

        for payment_method in payment_methods.filtered("taplink_refresh_token"):
            mode = payment_method.taplink_runtime_mode or "production"
            refresh_key = (mode, payment_method.taplink_refresh_token)
            if refresh_key in seen_refresh_keys:
                continue
            seen_refresh_keys.add(refresh_key)

            new_tokens = payment_method._taplink_request_refresh_tokens()
            if not new_tokens:
                continue

            payment_methods.filtered(
                lambda pm, m=mode, rt=payment_method.taplink_refresh_token: (
                    (pm.taplink_runtime_mode or "production") == m and pm.taplink_refresh_token == rt
                )
            ).write(new_tokens)
            latest_tokens_by_mode[mode] = new_tokens
            payment_method._taplink_propagate_tokens_same_mode(new_tokens)

        for mode, tokens in latest_tokens_by_mode.items():
            without_refresh = payment_methods.filtered(
                lambda pm, m=mode: (pm.taplink_runtime_mode or "production") == m
                and not pm.taplink_refresh_token
            )
            if without_refresh:
                without_refresh.write(tokens)
                _logger.info(
                    "Propagated Taplink OAuth tokens to %s payment method(s) on mode %s.",
                    len(without_refresh),
                    mode,
                )

        missing = payment_methods.filtered(lambda pm: not pm.taplink_refresh_token)
        for payment_method in missing:
            _logger.warning(
                "Taplink payment method %s has no refresh token; run Generate Token on any "
                "Teya payment method with the same payment mode.",
                payment_method.display_name,
            )

    def _taplink_device_oauth_base_url(self):
        if self.taplink_runtime_mode == "test":
            return "https://id.teya.xyz/oauth/v2"
        return "https://id.teya.com/oauth/v2"

    def action_taplink_device_authorize(self):
        if self._is_write_forbidden({"taplink_access_token", "taplink_refresh_token"}):
            raise UserError(
                _(
                    "Please close and validate the following open PoS Sessions before modifying this payment method.\n"
                    "Open sessions: %s",
                    (" ".join(self.open_session_ids.mapped("name")),),
                )
            )

        if self.taplink_runtime_mode == "test":
            device_url = "https://id.teya.xyz/oauth/v2/device"
        else:
            device_url = "https://id.teya.com/oauth/v2/device"

        device_payload = (
            f"client_id={resolve_taplink_client_id()}&client_secret={resolve_taplink_client_secret()}"
        )
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        try:
            response = requests.request(
                "POST", device_url, headers=headers, data=device_payload, timeout=30
            )
        except requests.RequestException as error:
            raise UserError(_("Could not connect to Teya: %s", error)) from error
        if response.status_code != 200:
            raise UserError(
                _(
                    "Teya device authorization failed (HTTP %s): %s",
                    response.status_code,
                    _taplink_api_error_message(response),
                )
            )

        qr_code_str = response.json().get("qr_code")
        if not qr_code_str:
            raise UserError(_("Teya did not return a QR code. Please try again."))

        if qr_code_str.startswith("data:image"):
            qr_code_str = qr_code_str.split(",")[1]
        missing_padding = len(qr_code_str) % 4
        if missing_padding:
            qr_code_str += "=" * (4 - missing_padding)
        qr_code_bytes = base64.b64decode(qr_code_str)
        qr_code_bin = base64.b64encode(qr_code_bytes)

        return {
            "type": "ir.actions.act_window",
            "name": _("Verify Device"),
            "res_model": "taplink.device.auth.wizard",
            "view_mode": "form",
            "context": {
                "default_qr_code": qr_code_bin,
                "default_verification_uri": response.json().get("verification_url_complete"),
                "default_device_code": response.json().get("device_code"),
                "default_payment_method_id": self.id,
            },
            "target": "new",
        }

    def action_taplink_sync_outlets(self):
        payment_method = self
        if self._is_write_forbidden({"taplink_access_token", "taplink_refresh_token"}):
            raise UserError(
                _(
                    "Please close and validate the following open PoS Sessions before modifying this payment method.\n"
                    "Open sessions: %s",
                    (" ".join(self.open_session_ids.mapped("name")),),
                )
            )

        if not payment_method:
            raise UserError(_("No integrated POS payment method found."))

        if payment_method.taplink_runtime_mode == "test":
            url = "https://api.teya.xyz/poslink/v1/stores"
        else:
            url = "https://api.teya.com/poslink/v1/stores"
        payload = {}
        headers = {
            "Accept": "application/json",
            "Authorization": payment_method._taplink_bearer_authorization(),
        }
        try:
            response = requests.request("GET", url, headers=headers, data=payload, timeout=30)
        except requests.RequestException as error:
            raise UserError(_("Could not connect to Teya: %s", error)) from error

        if response.status_code == 401:
            if not payment_method.taplink_refresh_token:
                raise UserError(
                    _(
                        "Teya access token expired and no refresh token is available. "
                        "Click Generate Token and authorize the device again."
                    )
                )
            payment_method._cron_taplink_refresh_oauth_tokens()
            headers["Authorization"] = payment_method._taplink_bearer_authorization()
            response = requests.request("GET", url, headers=headers, data=payload, timeout=30)

        if response.status_code != 200:
            raise UserError(
                _(
                    "Teya could not load stores (HTTP %s): %s",
                    response.status_code,
                    _taplink_api_error_message(response),
                )
            )

        stores = response.json().get("stores")
        for store in stores:
            address = store.get("address")
            country_id = self.env["res.country"].search(
                [("code", "=", address.get("country"))], limit=1
            )

            outlet = self.env["taplink.merchant.outlet"].search(
                [("external_outlet_id", "=", store.get("id"))], limit=1
            )
            if not outlet:
                outlet = self.env["taplink.merchant.outlet"].create(
                    {
                        "external_outlet_id": store.get("id"),
                        "name": store.get("name"),
                        "city": address.get("city"),
                        "country_id": country_id.id,
                        "street_1": address.get("street_address_line_1"),
                        "street_2": address.get("street_address_line_2"),
                        "zipcode": address.get("zipcode"),
                        "linked_payment_method_id": payment_method.id,
                    }
                )

            if self.taplink_runtime_mode == "test":
                terminals_url = (
                    f"https://api.teya.xyz/poslink/v1/stores/{outlet.external_outlet_id}/terminals"
                )
            else:
                terminals_url = (
                    f"https://api.teya.com/poslink/v1/stores/{outlet.external_outlet_id}/terminals"
                )

            terminal_response = requests.request("GET", terminals_url, headers=headers, data=payload)
            if terminal_response.status_code == 200:
                terminals = terminal_response.json().get("terminals")
                for terminal in terminals:
                    reader = self.env["taplink.card.reader"].search(
                        [("name", "=", terminal.get("serial_number"))], limit=1
                    )
                    if not reader:
                        self.env["taplink.card.reader"].create(
                            {
                                "name": terminal.get("serial_number"),
                                "reader_api_id": terminal.get("terminal_id"),
                                "reader_label": terminal.get("terminal_name"),
                                "outlet_id": outlet.id,
                            }
                        )

    def taplink_create_payment_request(self, data, config_id, order_token, operation=False):
        if self.taplink_runtime_mode == "test":
            url = "https://api.teya.xyz/poslink/v2/payment-requests"
        else:
            url = "https://api.teya.com/poslink/v2/payment-requests"

        config = self.env["pos.config"].browse(config_id)
        outlet = self.taplink_outlet_id
        reader = self._taplink_resolve_card_reader(config)
        if not outlet.external_outlet_id:
            raise UserError(_("Outlet “%s” has no external store id.", outlet.display_name))
        data.update(
            {
                "store_id": outlet.external_outlet_id,
                "terminal_id": reader.reader_api_id,
            }
        )
        _logger.info(
            "Taplink payment request for method %s → outlet %s, reader %s (%s)",
            self.display_name,
            outlet.external_outlet_id,
            reader.reader_api_id,
            reader.display_name,
        )

        headers = {
            "Idempotency-Key": order_token,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": self._taplink_bearer_authorization(),
        }
        _logger.info("Taplink proxy request headers/data: %s, %s", data, headers)

        response = requests.post(url, json=data, headers=headers)
        _logger.info("Taplink proxy response: %s, code %s", response, response.status_code)

        if response.status_code == 401:
            _logger.info("Taplink token expired. Attempting token refresh in taplink_create_payment_request.")
            self._cron_taplink_refresh_oauth_tokens()
            headers["Authorization"] = self._taplink_bearer_authorization()
            response = requests.post(url, json=data, headers=headers)
            _logger.info("Taplink proxy response after refresh: %s, code %s", response, response.status_code)

        if response.status_code == 401:
            return {"status_code": response.status_code, "message": _taplink_api_error_message(response)}
        if response.status_code == 400:
            return {"status_code": response.status_code, "message": _taplink_api_error_message(response)}
        if response.status_code not in (200, 201):
            return {
                "status_code": response.status_code,
                "message": _taplink_api_error_message(response),
            }
        try:
            return response.json()
        except (ValueError, requests.exceptions.JSONDecodeError):
            return {
                "status_code": response.status_code,
                "message": _("Invalid response from Teya. Check server logs."),
            }

    def taplink_poll_payment_request(self, payment_req_id, pos_session_id):
        if not payment_req_id or str(payment_req_id).lower() in ("none", "false", "0"):
            return {
                "status_code": 400,
                "message": _("Missing payment request id; start a new payment after fixing the error."),
            }

        if self.taplink_runtime_mode == "test":
            url = f"https://api.teya.xyz/poslink/v1/payment-requests/{payment_req_id}"
        else:
            url = f"https://api.teya.com/poslink/v1/payment-requests/{payment_req_id}"

        pos_session = self.env["pos.session"].browse(pos_session_id)
        headers = {
            "Accept": "application/json",
            "Authorization": self._taplink_bearer_authorization(),
        }

        _logger.info("Taplink payment request status: GET %s", url)
        response = requests.get(url, headers=headers)
        _logger.info("taplink_poll_payment_request response: %s, %s", response.status_code, response.text)

        if response.status_code == 401:
            _logger.info("Taplink token expired. Attempting token refresh in taplink_poll_payment_request.")
            self._cron_taplink_refresh_oauth_tokens()
            headers["Authorization"] = self._taplink_bearer_authorization()
            response = requests.get(url, headers=headers)

        if response.status_code == 401:
            _logger.info("taplink_poll_payment_request still 401 after refresh")
            return {"status_code": response.status_code, "message": response.json().get("message")}

        if response.status_code != 200:
            return {"status_code": response.status_code, "message": _taplink_api_error_message(response)}

        try:
            body = response.json()
        except (ValueError, requests.exceptions.JSONDecodeError):
            return {
                "status_code": response.status_code,
                "message": _("Invalid response from Teya. Check server logs."),
            }

        body["payment_request_id"] = payment_req_id
        payload = {
            "config_id": pos_session.config_id.id,
            "payment_request_id": payment_req_id,
            "response": body,
        }
        status = (body.get("status") or "").upper()
        if status in ("SUCCESS", "APPROVED", "COMPLETED", "CAPTURED"):
            status = "SUCCESSFUL"
            body["status"] = status
        _logger.info("taplink_poll_payment_request body: %s", body)
        if status in ("SUCCESSFUL", "CANCELLED", "FAILED"):
            pos_session.config_id._notify("TAPLINK_PAYMENT_STATUS", payload)
            return body

        return {"status": "pending", "payment_request_id": payment_req_id}

    def taplink_abort_payment_request(self, payment_req_id):
        """Cancel an in-flight payment request (best-effort)."""
        self.ensure_one()
        if not payment_req_id or str(payment_req_id).lower() in ("none", "false", "0"):
            return {"status_code": 400, "message": _("Missing payment request id to cancel.")}

        if self.taplink_runtime_mode == "test":
            url = f"https://api.teya.xyz/poslink/v1/payment-requests/{payment_req_id}"
        else:
            url = f"https://api.teya.com/poslink/v1/payment-requests/{payment_req_id}"

        headers = {
            "Accept": "application/json",
            "Authorization": self._taplink_bearer_authorization(),
        }
        _logger.info("Taplink cancel payment request: DELETE %s", url)
        try:
            response = requests.delete(url, headers=headers, timeout=30)
        except requests.RequestException as exc:
            return {"status_code": 503, "message": str(exc)}

        if response.status_code == 401:
            self._cron_taplink_refresh_oauth_tokens()
            headers["Authorization"] = self._taplink_bearer_authorization()
            response = requests.delete(url, headers=headers, timeout=30)

        _logger.info(
            "Taplink cancel payment request response: %s %s",
            response.status_code,
            (response.text or "")[:500],
        )
        if response.status_code in (200, 202, 204):
            return {"cancelled": True}
        if response.status_code == 401:
            return {"status_code": response.status_code, "message": _taplink_api_error_message(response)}
        return {
            "status_code": response.status_code,
            "message": _taplink_api_error_message(response),
        }
