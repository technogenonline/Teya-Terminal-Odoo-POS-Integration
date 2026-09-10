# -*- coding: utf-8 -*-
from odoo import api, fields, models


class PosConfig(models.Model):
    _inherit = "pos.config"

    @api.model
    def _load_pos_data_fields(self, config_id):
        # Core pos.config returns [] meaning "all fields" (see check_field_access_rights).
        # Appending to [] would restrict search_read to only our field and break POS load.
        fields_list = super()._load_pos_data_fields(config_id)
        if not fields_list:
            return fields_list
        extra = []
        if "enable_payment_split" not in fields_list:
            extra.append("enable_payment_split")
        if "allow_terminal_force_done" not in fields_list:
            extra.append("allow_terminal_force_done")
        return fields_list + extra if extra else fields_list

    enable_payment_split = fields.Boolean(
        string="Payment split dialog",
        default=True,
        help="When enabled, selecting a payment method opens a split dialog "
        "(amount or percentage) before charging.",
    )
    allow_terminal_force_done = fields.Boolean(
        string="Allow Force Done",
        default=False,
        help="When enabled, cashiers can force-complete a stuck terminal payment "
        "after entering an advanced employee PIN.",
    )
