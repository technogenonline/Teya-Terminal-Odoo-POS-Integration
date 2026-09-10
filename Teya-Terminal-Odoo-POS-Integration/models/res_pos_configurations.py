from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    module_teya_payment_terminal_integration = fields.Boolean(
        string="Teya Payment Terminal",
        help="The transactions are processed by Teya.",
    )
