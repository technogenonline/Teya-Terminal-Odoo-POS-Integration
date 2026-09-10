/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { patch } from "@web/core/utils/patch";
import { useState } from "@odoo/owl";
import {
    computeEqualSplitAmounts,
    getTaplinkSplitChargeAmount,
    listTaplinkPaymentMethods,
    roundPaymentAmount,
} from "@teya_payment_terminal_integration/app/taplink_split_math";
import { TaplinkEqualSplitPanel } from "./taplink_equal_split_panel";

PaymentScreen.components = {
    ...PaymentScreen.components,
    TaplinkEqualSplitPanel,
};

patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        this.taplinkSplitUi = useState({ splitCount: 0, useEqualSplit: false });
        this.pos.taplinkOnGatewaySettled = (line, isPaymentSuccessful) => {
            if (!isPaymentSuccessful || line.pos_order_id !== this.currentOrder) {
                return;
            }
            const plan = this.currentOrder.getTaplinkEqualSplitState();
            if (!plan?.active || plan.mode) {
                // pos_payment_split dialog owns split-by flow (plan.mode is set).
                return;
            }
            // While sendPaymentRequest is running, it will advance the split itself.
            if (this.pos.paymentTerminalInProgress) {
                return;
            }
            void this._onTaplinkEqualSplitPaymentFinished(line);
        };
    },

    get taplinkPaymentMethods() {
        const configIds = new Set(this.pos.config.payment_method_ids.map((pm) => pm.id));
        const methods = this.pos.models["pos.payment.method"]
            .getAll()
            .filter((pm) => configIds.has(pm.id) && pm.use_payment_terminal === "taplink");
        return methods.length ? methods : listTaplinkPaymentMethods(this.payment_methods_from_config);
    },

    get cashPaymentMethod() {
        return this.payment_methods_from_config.find((pm) => pm.type === "cash");
    },

    get hasCashPaymentMethod() {
        return Boolean(this.cashPaymentMethod);
    },

    get taplinkEqualSplitPlan() {
        return this.currentOrder.getTaplinkEqualSplitState() || null;
    },

    get taplinkTerminalBusy() {
        return Boolean(this.pos.paymentTerminalInProgress);
    },

    onTaplinkSplitCountChange(count) {
        if (!count || count < 2) {
            this.taplinkSplitUi.splitCount = 0;
            this.taplinkSplitUi.useEqualSplit = false;
            return;
        }
        this.taplinkSplitUi.splitCount = Math.min(20, count);
        this.taplinkSplitUi.useEqualSplit = true;
    },

    _shouldAutoStartTaplinkSplit(paymentMethod) {
        return (
            paymentMethod?.use_payment_terminal === "taplink" &&
            this.taplinkSplitUi.useEqualSplit &&
            this.taplinkSplitUi.splitCount >= 2 &&
            !this.currentOrder.isTaplinkEqualSplitActive()
        );
    },

    async addNewPaymentLine(paymentMethod) {
        if (paymentMethod?.use_payment_terminal === "taplink" && this.currentOrder.isTaplinkEqualSplitActive()) {
            return this.startTaplinkEqualSplit(paymentMethod);
        }
        if (this._shouldAutoStartTaplinkSplit(paymentMethod)) {
            return this.startTaplinkEqualSplit(paymentMethod);
        }
        return super.addNewPaymentLine(...arguments);
    },

    async startTaplinkEqualSplit(paymentMethod) {
        const order = this.currentOrder;
        const existing = order.getTaplinkEqualSplitState();
        if (existing?.active) {
            if (existing.status === "stopped") {
                return this.retryTaplinkEqualSplit();
            }
            if (existing.index < existing.count && existing.status === "idle") {
                existing.paymentMethodId = paymentMethod.id;
                return this._advanceTaplinkEqualSplit();
            }
            return false;
        }

        const due = roundPaymentAmount(order.get_due(), this.pos.currency);
        if (due <= 0) {
            this.dialog.add(AlertDialog, {
                title: _t("Nothing to pay"),
                body: _t("This order is already fully paid."),
            });
            return false;
        }
        if (this.pos.paymentTerminalInProgress) {
            this.dialog.add(AlertDialog, {
                title: _t("Error"),
                body: _t("There is already an electronic payment in progress."),
            });
            return false;
        }

        const count = this.taplinkSplitUi.splitCount;
        if (!this.taplinkSplitUi.useEqualSplit || count < 2) {
            this.dialog.add(AlertDialog, {
                title: _t("Split not configured"),
                body: _t("Enter a value of 2 or more in Split into, then press Terminal."),
            });
            return false;
        }
        this.taplinkSplitUi.useEqualSplit = true;
        const amounts = computeEqualSplitAmounts(due, count, this.pos.currency);
        order.taplink_gateway_ref = "";
        order.taplink_tx_ref = "";
        order.taplink_gateway_payload = "";
        order.setTaplinkEqualSplitState({
            active: true,
            count,
            amounts,
            index: 0,
            lastCompletedIndex: -1,
            initialDue: due,
            paymentMethodId: paymentMethod.id,
            status: "idle",
            pendingAmount: null,
            stopRequested: false,
        });

        return this._advanceTaplinkEqualSplit();
    },

    _findTaplinkSplitPendingLine(order, plan) {
        return order.payment_ids.find(
            (line) =>
                line.payment_method_id.use_payment_terminal === "taplink" &&
                (!plan?.paymentMethodId || line.payment_method_id.id === plan.paymentMethodId) &&
                !line.is_done() &&
                ["waitingCard", "waiting", "waitingCancel", "retry", "pending"].includes(
                    line.get_payment_status()
                )
        );
    },

    async _advanceTaplinkEqualSplit() {
        const order = this.currentOrder;
        const plan = order.getTaplinkEqualSplitState();
        if (!plan?.active) {
            return false;
        }
        if (plan.status === "stopped" || plan.stopRequested) {
            return false;
        }

        if (plan.index >= plan.count) {
            plan.status = "completed";
            order.clearTaplinkEqualSplitState();
            if (order.is_paid() && this.pos.config.auto_validate_terminal_payment) {
                await this.validateOrder(false);
            }
            return true;
        }

        if (order.get_due() <= 0) {
            plan.status = "completed";
            order.clearTaplinkEqualSplitState();
            return true;
        }

        const paymentMethod = this.payment_methods_from_config.find(
            (pm) => pm.id === plan.paymentMethodId
        );
        if (!paymentMethod) {
            order.clearTaplinkEqualSplitState();
            return false;
        }

        const amount = getTaplinkSplitChargeAmount(order, plan, this.pos.currency);
        if (amount <= 0) {
            plan.index += 1;
            return this._advanceTaplinkEqualSplit();
        }

        plan.pendingAmount = amount;
        plan.status = "in_progress";

        const line = order.add_paymentline(paymentMethod);
        if (!this.check_cash_rounding_has_been_well_applied()) {
            order.clearTaplinkEqualSplitState();
            return false;
        }
        if (!line) {
            this.dialog.add(AlertDialog, {
                title: _t("Error"),
                body: _t("Could not add a payment line for the split payment."),
            });
            plan.status = "stopped";
            return false;
        }

        line.set_amount(amount);
        this.numberBuffer.reset();
        await this.sendPaymentRequest(line);
        return true;
    },

    async sendPaymentRequest(line) {
        const order = this.currentOrder;
        const plan = order.getTaplinkEqualSplitState();
        const isTaplink = line.payment_method_id.use_payment_terminal === "taplink";
        // Legacy Teya equal-split panel only (no pos_payment_split dialog plan).
        const isLegacyTeyaSplit = plan?.active && !plan.mode && isTaplink;

        if (isLegacyTeyaSplit) {
            plan.status = "waiting_terminal";
        }

        await super.sendPaymentRequest(line);

        if (!isLegacyTeyaSplit) {
            return;
        }

        if (plan.status === "stopped" || plan.stopRequested) {
            return;
        }

        await this._onTaplinkEqualSplitPaymentFinished(line);
    },

    async _onTaplinkEqualSplitPaymentFinished(line) {
        const order = this.currentOrder;
        const plan = order.getTaplinkEqualSplitState();
        if (!plan?.active) {
            return;
        }

        if (line.is_done()) {
            if (plan.lastCompletedIndex === plan.index) {
                return;
            }
            plan.lastCompletedIndex = plan.index;
            plan.index += 1;
            plan.status = "idle";
            plan.pendingAmount = null;
            if (plan.index < plan.count && order.get_due() > 0 && !plan.stopRequested) {
                await this._advanceTaplinkEqualSplit();
                return;
            }
            plan.status = "completed";
            order.clearTaplinkEqualSplitState();
            if (order.is_paid() && this.pos.config.auto_validate_terminal_payment) {
                await this.validateOrder(false);
            }
            return;
        }

        if (line.get_payment_status() === "retry") {
            plan.status = "stopped";
        }
    },

    async stopTaplinkEqualSplit() {
        const order = this.currentOrder;
        const plan = order.getTaplinkEqualSplitState();
        if (!plan?.active) {
            return;
        }

        plan.stopRequested = true;
        plan.status = "stopped";

        const pendingLine = this._findTaplinkSplitPendingLine(order, plan);
        if (pendingLine) {
            const iface = pendingLine.payment_method_id.payment_terminal;
            if (iface && pendingLine.get_payment_status() === "waitingCard") {
                await this.sendPaymentCancel(pendingLine);
            } else if (iface) {
                await iface.send_payment_cancel(order, pendingLine.uuid);
                pendingLine.set_payment_status("retry");
                this.pos.paymentTerminalInProgress = false;
            }
        }

        this.pos.paymentTerminalInProgress = false;
    },

    cancelTaplinkEqualSplit() {
        const order = this.currentOrder;
        const plan = order.getTaplinkEqualSplitState();
        if (!plan) {
            return;
        }

        const linesToRemove = order.payment_ids.filter(
            (line) => line.payment_method_id.use_payment_terminal === "taplink" && !line.is_done()
        );
        for (const line of linesToRemove) {
            order.remove_paymentline(line);
        }
        order.clearTaplinkEqualSplitState();
        this.taplinkSplitUi.useEqualSplit = false;
        this.pos.paymentTerminalInProgress = false;
        this.numberBuffer.reset();
    },

    async retryTaplinkEqualSplit() {
        const order = this.currentOrder;
        const plan = order.getTaplinkEqualSplitState();
        if (!plan?.active || plan.status !== "stopped") {
            return;
        }

        plan.stopRequested = false;

        const retryLine = order.payment_ids.find(
            (line) =>
                line.payment_method_id.id === plan.paymentMethodId &&
                line.get_payment_status() === "retry"
        );

        plan.status = "in_progress";
        if (retryLine) {
            plan.pendingAmount = getTaplinkSplitChargeAmount(order, plan, this.pos.currency);
            retryLine.set_amount(plan.pendingAmount);
            await this.sendPaymentRequest(retryLine);
            return;
        }

        plan.status = "idle";
        await this._advanceTaplinkEqualSplit();
    },

    async sendPaymentCancel(line) {
        const order = this.currentOrder;
        const plan = order.getTaplinkEqualSplitState();
        const isTaplink = line.payment_method_id?.use_payment_terminal === "taplink";
        await super.sendPaymentCancel(line);
        if (
            isTaplink &&
            plan?.active &&
            ["waiting_terminal", "in_progress", "idle"].includes(plan.status)
        ) {
            plan.stopRequested = true;
            plan.status = "stopped";
            this.pos.paymentTerminalInProgress = false;
        }
    },

    async forceDoneTaplinkEqualSplit() {
        const order = this.currentOrder;
        const plan = order.getTaplinkEqualSplitState();
        if (!plan?.active) {
            return;
        }
        const pendingLine = this._findTaplinkSplitPendingLine(order, plan);
        if (!pendingLine) {
            this.dialog.add(AlertDialog, {
                title: _t("No pending payment"),
                body: _t("There is no Teya payment waiting to be forced complete."),
            });
            return;
        }
        await this.sendForceDone(pendingLine);
    },

    async payTaplinkSplitWithCash() {
        const order = this.currentOrder;
        const due = order.get_due();
        if (due <= 0) {
            return;
        }

        const cashMethod = this.cashPaymentMethod;
        if (!cashMethod) {
            return;
        }

        let plan = order.getTaplinkEqualSplitState();
        if (!plan?.active) {
            if (!this.taplinkSplitUi.useEqualSplit || this.taplinkSplitUi.splitCount < 2) {
                this.dialog.add(AlertDialog, {
                    title: _t("Split not configured"),
                    body: _t("Enter a value of 2 or more in Split into first."),
                });
                return;
            }
            const count = this.taplinkSplitUi.splitCount;
            const amounts = computeEqualSplitAmounts(due, count, this.pos.currency);
            order.setTaplinkEqualSplitState({
                active: true,
                count,
                amounts,
                index: 0,
                lastCompletedIndex: -1,
                initialDue: due,
                paymentMethodId: null,
                status: "idle",
                pendingAmount: null,
                stopRequested: false,
            });
            plan = order.getTaplinkEqualSplitState();
        }

        if (plan.status === "waiting_terminal" || plan.status === "in_progress") {
            return;
        }

        const amount = getTaplinkSplitChargeAmount(order, plan, this.pos.currency);
        const line = order.add_paymentline(cashMethod);
        if (!line) {
            return;
        }
        line.set_amount(amount);
        line.set_payment_status("done");
        plan.index += 1;
        plan.status = "idle";
        this.numberBuffer.reset();

        if (plan.index >= plan.count || order.get_due() <= 0) {
            order.clearTaplinkEqualSplitState();
            if (order.is_paid() && this.pos.config.auto_validate_terminal_payment) {
                await this.validateOrder(false);
            }
        }
    },
});
