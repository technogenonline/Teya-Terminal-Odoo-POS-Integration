# -*- coding: utf-8 -*-
{
    "name": "POS Payment Split",
    "version": "18.0.1.0.26",
    "category": "Sales/Point of Sale",
    "summary": "Split POS payments by fixed amount or percentage (terminal-friendly)",
    "description": """
        Opens a split payment dialog when a payment method is selected.
        Supports amount-based and percentage-based splits with correct
        remaining balance handling. Compatible with Teya and DNA terminal modules.
    """,
    "author": "Sopan Digital PVT. LTD (Nick)",
    "license": "LGPL-3",
    "depends": ["point_of_sale"],
    "data": [
        "views/pos_config_views.xml",
    ],
    "assets": {
        "point_of_sale._assets_pos": [
            "pos_payment_split/static/src/app/**/*.js",
            "pos_payment_split/static/src/app/**/*.xml",
            "pos_payment_split/static/src/app/**/*.scss",
            "pos_payment_split/static/src/overrides/**/*.js",
            "pos_payment_split/static/src/overrides/**/*.xml",
            "pos_payment_split/static/src/integrations/payment_terminal_compat.js",
        ],
    },
    "installable": True,
    "application": False,
}
