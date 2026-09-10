/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { PosStore } from "@point_of_sale/app/store/pos_store";
import {
    getPaymentSplitChargeAmount,
    roundPaymentAmount,
} from "@pos_payment_split/app/split_payment_math";

function resolveTerminalChargeAmount(pos, line) {
    const order = line?.pos_order_id || pos.get_order();
    const currency = pos.currency;
    const plan = order.getPaymentSplitState?.();
    if (plan?.active) {
        const charge = getPaymentSplitChargeAmount(order, plan, currency, {
            paymentMethod: line?.payment_method_id,
        });
        line.set_amount(charge);
        return charge;
    }
    const due = roundPaymentAmount(order.get_due(), currency);
    if (due > 0) {
        line.set_amount(due);
        return due;
    }
    return roundPaymentAmount(line.amount, currency);
}

const teyaShouldAutoStartTaplinkSplit = PaymentScreen.prototype._shouldAutoStartTaplinkSplit;

patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        const previousTaplinkHandler = this.pos.taplinkOnGatewaySettled;
        this.pos.taplinkOnGatewaySettled = (line, isPaymentSuccessful) => {
            if (typeof previousTaplinkHandler === "function") {
                previousTaplinkHandler(line, isPaymentSuccessful);
            }
            if (
                typeof this.pos.onPaymentSplitSettled === "function" &&
                !this.pos.paymentTerminalInProgress &&
                !this.pos._posPaymentSplitHandlingTerminalRequest
            ) {
                this.pos.onPaymentSplitSettled(line, isPaymentSuccessful);
            }
        };
    },

    _shouldAutoStartTaplinkSplit(paymentMethod) {
        if (this.pos.config.enable_payment_split) {
            return false;
        }
        if (typeof teyaShouldAutoStartTaplinkSplit === "function") {
            return teyaShouldAutoStartTaplinkSplit.call(this, paymentMethod);
        }
        return false;
    },
});

function patchTerminalInterface(terminalKey) {
    const TerminalInterface = PosStore.prototype.electronic_payment_interfaces?.[terminalKey];
    if (!TerminalInterface || TerminalInterface.prototype._posPaymentSplitPatched) {
        return;
    }
    patch(TerminalInterface.prototype, {
        async send_payment_request(uuid) {
            const order = this.pos.get_order();
            const line = order?.payment_ids.find((p) => p.uuid === uuid);
            if (line) {
                resolveTerminalChargeAmount(this.pos, line);
            }
            return super.send_payment_request(...arguments);
        },
    });
    TerminalInterface.prototype._posPaymentSplitPatched = true;
}

patch(PosStore.prototype, {
    async setup() {
        await super.setup(...arguments);
        patchTerminalInterface("dna");
        patchTerminalInterface("taplink");
    },
});
