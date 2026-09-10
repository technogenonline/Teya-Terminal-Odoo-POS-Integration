/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { Component } from "@odoo/owl";
import { getPaymentSplitChargeAmount } from "@pos_payment_split/app/split_payment_math";

export class SplitPaymentStatus extends Component {
    static template = "pos_payment_split.SplitPaymentStatus";
    static props = {
        order: Object,
        plan: { type: [Object, { value: null }], optional: true },
        formatCurrency: Function,
        terminalInProgress: Boolean,
        onStop: Function,
        onCancel: Function,
        onRetry: Function,
    };

    get progressLabel() {
        const plan = this.props.plan;
        if (!plan?.active) {
            return "";
        }
        const current = Math.min(plan.index + 1, plan.count);
        return _t("Payment %(current)s of %(total)s", {
            current: String(current),
            total: String(plan.count),
        });
    }

    get currentCharge() {
        const plan = this.props.plan;
        if (!plan?.active) {
            return 0;
        }
        return getPaymentSplitChargeAmount(
            this.props.order,
            plan,
            this.props.order.currency
        );
    }

    get hasPendingTerminalLine() {
        return this.props.order.payment_ids.some(
            (line) =>
                line.payment_method_id.use_payment_terminal &&
                !line.is_done() &&
                ["waitingCard", "waiting", "waitingCancel", "pending"].includes(
                    line.get_payment_status()
                )
        );
    }

    get showPanel() {
        return (
            Boolean(this.props.plan?.active) ||
            this.props.terminalInProgress ||
            this.hasPendingTerminalLine
        );
    }

    get showStop() {
        const plan = this.props.plan;
        const waitingOnTerminal =
            this.props.terminalInProgress ||
            this.hasPendingTerminalLine ||
            (plan?.active && ["waiting_terminal", "in_progress"].includes(plan.status));
        if (!waitingOnTerminal) {
            return false;
        }
        return Boolean(plan?.active) || this.hasPendingTerminalLine;
    }

    get showStopped() {
        return this.props.plan?.active && this.props.plan.status === "stopped";
    }
}
