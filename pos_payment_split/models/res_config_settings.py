# -*- coding: utf-8 -*-
from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    pos_enable_payment_split = fields.Boolean(
        string="Payment split dialog",
        related="pos_config_id.enable_payment_split",
        readonly=False,
    )
    pos_allow_terminal_force_done = fields.Boolean(
        string="Allow Force Done",
        related="pos_config_id.allow_terminal_force_done",
        readonly=False,
    )
