from odoo import api, fields, models


class PosOrder(models.Model):
    _inherit = "pos.order"

    taplink_gateway_ref = fields.Char(string="Gateway Payment ID")
    taplink_tx_ref = fields.Char(string="Transaction ID")
    taplink_gateway_payload = fields.Text(string="Gateway payload")

    @api.model
    def _order_fields(self, ui_order):
        order_fields = super()._order_fields(ui_order)
        order_fields["taplink_gateway_ref"] = ui_order.get("taplink_gateway_ref", False)
        order_fields["taplink_tx_ref"] = ui_order.get("taplink_tx_ref", False)
        order_fields["taplink_gateway_payload"] = ui_order.get("taplink_gateway_payload", False)
        return order_fields

    def _export_for_ui(self, order):
        result = super()._export_for_ui(order)
        result.update(
            {
                "taplink_gateway_ref": order.taplink_gateway_ref,
                "taplink_tx_ref": order.taplink_tx_ref,
                "taplink_gateway_payload": order.taplink_gateway_payload,
            }
        )
        return result
