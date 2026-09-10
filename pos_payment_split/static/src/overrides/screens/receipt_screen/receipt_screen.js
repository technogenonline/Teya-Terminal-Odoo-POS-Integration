/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { ReceiptScreen } from "@point_of_sale/app/screens/receipt_screen/receipt_screen";
import { patch } from "@web/core/utils/patch";
import { roundPaymentAmount } from "@pos_payment_split/app/split_payment_math";

patch(ReceiptScreen.prototype, {
    isContinuePartialPayment() {
        const order = this.currentOrder;
        if (!order || order.finalized || order.is_paid()) {
            return false;
        }
        const due = roundPaymentAmount(order.get_due(), order.currency);
        const hasCompletedPayment = order.payment_ids.some(
            (line) => line.is_done() && line.get_amount() > 0
        );
        return due > 0 && hasCompletedPayment;
    },

    continuePartialPayment() {
        const order = this.currentOrder;
        order.recomputeOrderData();
        order.uiState._posPaymentSplitContinue = true;
        order.uiState.screen_data.value = "";
        const paymentProps = { orderUuid: order.uuid };
        const hasTable = Boolean(order.table_id || order.getTable?.());
        if (hasTable) {
            order.set_screen_data({ name: "PaymentScreen", props: paymentProps });
            this.pos.showScreen("PaymentScreen", paymentProps);
            return;
        }
        order.set_screen_data({ name: "ProductScreen" });
        this.pos.showScreen("ProductScreen");
    },

    get nextScreen() {
        if (this.isContinuePartialPayment()) {
            const order = this.currentOrder;
            if (order.table_id || order.getTable?.()) {
                return { name: "PaymentScreen", props: { orderUuid: order.uuid } };
            }
        }
        return super.nextScreen;
    },
});
