/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { PaymentScreenPaymentLines } from "@point_of_sale/app/screens/payment_screen/payment_lines/payment_lines";
import { patch } from "@web/core/utils/patch";

const TAPLINK_CANCEL_STATUSES = ["waitingCard", "waitingCapture", "waiting", "pending"];

patch(PaymentScreenPaymentLines.prototype, {
    isTaplinkLine(line) {
        return line.payment_method_id?.use_payment_terminal === "taplink";
    },

    canShowTaplinkLineCancel(line) {
        return (
            this.isTaplinkLine(line) &&
            TAPLINK_CANCEL_STATUSES.includes(line.get_payment_status())
        );
    },

    taplinkCancelLabel() {
        return this.ui.isSmall ? _t("Cancel") : _t("Cancel terminal");
    },

    cancelTaplinkPayment(line) {
        if (!this.canShowTaplinkLineCancel(line)) {
            return;
        }
        this.props.sendPaymentCancel(line);
    },
});
