from odoo import fields, models


class TaplinkMerchantOutlet(models.Model):
    _name = "taplink.merchant.outlet"
    _description = "Merchant outlet (Teya PosLink)"

    name = fields.Char(string="Name")
    external_outlet_id = fields.Char(string="Outlet id")
    city = fields.Char(string="City")
    country_id = fields.Many2one("res.country", string="Country")
    street_1 = fields.Char(string="Street 1")
    street_2 = fields.Char(string="Street 2")
    zipcode = fields.Char(string="Zipcode")
    linked_payment_method_id = fields.Many2one("pos.payment.method", string="Payment method")
