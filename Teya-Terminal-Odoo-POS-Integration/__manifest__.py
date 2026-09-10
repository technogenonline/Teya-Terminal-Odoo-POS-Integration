{
    "name": "Teya Payment Terminal (PosLink)",
    "version": "18.0.2.0.11",
    "category": "Sales/Point of Sale",
    "depends": ["point_of_sale", "pos_payment_split"],
    "license": "OPL-1",
    "summary": "Teya terminal payments with equal bill split on POS",
    "description": "Teya PosLink integration for Odoo 18 POS including cancel on terminal, mobile-friendly cancel on payment lines, equal split payments, and exact terminal amounts.",
    "data": [
        "security/ir.model.access.csv",
        "data/ir_cron.xml",
        "views/pos_config.xml",
        "views/pos_order.xml",
        "views/pos_payment_method_taplink.xml",
        "views/res_pos_configuration.xml",
        "views/taplink_merchant_outlet_views.xml",
        "views/taplink_card_reader_views.xml",
        "wizard/device_auth_wizard.xml",
    ],
    "installable": True,
    "auto_install": False,
    "application": True,
    "assets": {
        "point_of_sale._assets_pos": [
            "teya_payment_terminal_integration/static/src/**/*",
        ],
    },
}
