from odoo import fields, models


class TaplinkCardReader(models.Model):
    _name = "taplink.card.reader"
    _description = "Card reader (Teya PosLink)"

    name = fields.Char(string="Serial Number")
    outlet_id = fields.Many2one("taplink.merchant.outlet", string="Outlet")
    reader_api_id = fields.Char(string="Terminal ID", required=True)
    reader_label = fields.Char(string="Terminal Name")

    def name_get(self):
        result = []
        for reader in self:
            if reader.reader_label and reader.name:
                label = f"{reader.reader_label} ({reader.name})"
            else:
                label = reader.reader_label or reader.name or reader.reader_api_id
            result.append((reader.id, label))
        return result
