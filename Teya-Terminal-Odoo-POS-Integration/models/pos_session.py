from odoo import api, models


class PosSession(models.Model):
    _inherit = "pos.session"

    @api.model_create_multi
    def create(self, vals_list):
        taplink_methods = self.env["pos.payment.method"].sudo().search(
            [("use_payment_terminal", "=", "taplink")]
        )
        taplink_methods.sudo()._cron_taplink_refresh_oauth_tokens()
        return super().create(vals_list)

    def _validate_session(
        self, balancing_account=False, amount_to_balance=0, bank_payment_method_diffs=None
    ):
        res = super()._validate_session(
            balancing_account, amount_to_balance, bank_payment_method_diffs
        )
        taplink_methods = self.env["pos.payment.method"].sudo().search(
            [("use_payment_terminal", "=", "taplink")]
        )
        taplink_methods.sudo()._cron_taplink_refresh_oauth_tokens()
        return res
