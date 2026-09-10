/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { getTaplinkSplitChargeAmount } from "@teya_payment_terminal_integration/app/taplink_split_math";
import { roundPrecision } from "@web/core/utils/numbers";
import { Component } from "@odoo/owl";

export class TaplinkEqualSplitPanel extends Component {
    static template = "teya_payment_terminal_integration.TaplinkEqualSplitPanel";
    static props = {
        order: Object,
        formatCurrency: Function,
        splitCount: Number,
        useEqualSplit: Boolean,
        onSplitCountChange: Function,
        taplinkPaymentMethods: Array,
        plan: { type: [Object, { value: null }], optional: true },
        terminalInProgress: { type: Boolean, optional: true },
        onPayTerminal: Function,
        onPayCash: Function,
        onStop: Function,
        onCancelSplit: Function,
        onRetrySplit: Function,
        onForceDone: Function,
        hasCashMethod: Boolean,
    };

    get canStartSplit() {
        const plan = this.props.plan;
        const betweenParts = plan?.active && plan.status === "idle";
        return (
            this.props.useEqualSplit &&
            this.props.splitCount >= 2 &&
            (!plan?.active || betweenParts) &&
            !Boolean(this.props.terminalInProgress) &&
            !this.showStopButton &&
            this.props.order.get_due() > 0
        );
    }

    get perPartAmount() {
        const order = this.props.order;
        const count = Math.max(this.props.splitCount, 2);
        return roundPrecision(order.get_due() / count, order.currency?.rounding ?? 0.01);
    }

    get currentPartAmount() {
        const plan = this.props.plan;
        if (!plan?.active) {
            return 0;
        }
        return getTaplinkSplitChargeAmount(this.props.order, plan, this.props.order.currency);
    }

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

    get hasPendingTaplinkLine() {
        return this.props.order.payment_ids.some(
            (line) =>
                line.payment_method_id.use_payment_terminal === "taplink" &&
                !line.is_done() &&
                ["waitingCard", "waiting", "waitingCancel", "pending"].includes(
                    line.get_payment_status()
                )
        );
    }

    get showStopButton() {
        const plan = this.props.plan;
        if (!plan?.active || plan.status === "stopped") {
            return false;
        }
        return (
            ["waiting_terminal", "in_progress"].includes(plan.status) ||
            Boolean(this.props.terminalInProgress) ||
            this.hasPendingTaplinkLine
        );
    }

    get showStoppedActions() {
        return this.props.plan?.active && this.props.plan.status === "stopped";
    }

    get showPaymentActions() {
        return !this.showStopButton && !this.showStoppedActions;
    }

    onInputChange(ev) {
        const value = parseInt(ev.target.value, 10);
        this.props.onSplitCountChange(Number.isFinite(value) ? value : 0);
    }
}
