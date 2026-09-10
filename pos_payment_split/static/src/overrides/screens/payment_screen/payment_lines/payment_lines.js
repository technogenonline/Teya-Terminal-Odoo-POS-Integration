/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { PaymentScreenPaymentLines } from "@point_of_sale/app/screens/payment_screen/payment_lines/payment_lines";
import { patch } from "@web/core/utils/patch";

/** Payment statuses where staff may need to force-complete a terminal line. */
const TERMINAL_FORCE_DONE_STATUSES = [
    "retry",
    "force_done",
    "waitingCard",
    "waiting",
    "waitingCapture",
    "waitingCancel",
];

patch(PaymentScreenPaymentLines.prototype, {
    canRemovePaymentLine(line) {
        if (!line || line.is_change) {
            return false;
        }
        const status = line.get_payment_status();
        if (status === "done" || status === "reversed") {
            return false;
        }
        if (
            status &&
            ["waiting", "waitingCard", "waitingCancel", "waitingCapture"].includes(status)
        ) {
            return false;
        }
        return true;
    },

    isTerminalPaymentLine(line) {
        return Boolean(line.payment_method_id?.use_payment_terminal);
    },

    isTerminalForceDoneAllowed() {
        return Boolean(this.pos.config.allow_terminal_force_done);
    },

    canShowTerminalForceDone(line) {
        if (!this.isTerminalForceDoneAllowed() || !this.isTerminalPaymentLine(line)) {
            return false;
        }
        const status = line.get_payment_status();
        return TERMINAL_FORCE_DONE_STATUSES.includes(status);
    },

    terminalForceDoneTitle() {
        return _t("Force Done (advanced PIN)");
    },
});
