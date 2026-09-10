/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { patch } from "@web/core/utils/patch";
import { SplitPaymentDialog } from "@pos_payment_split/app/split_payment_dialog";
import {
    SPLIT_MODES,
    computeSplitAmounts,
    getPaymentSplitChargeAmount,
    maxEqualSplitParts,
    roundPaymentAmount,
} from "@pos_payment_split/app/split_payment_math";
import { SplitPaymentStatus } from "./split_payment_status";
import { requireTerminalManagerApproval } from "@pos_payment_split/app/terminal_manager_gate";

patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        this._posPaymentSplitSuppressDialog = false;
        this.pos.onPaymentSplitSettled = (line, isPaymentSuccessful) => {
            if (!isPaymentSuccessful || line.pos_order_id !== this.currentOrder) {
                return;
            }
            const plan = this.currentOrder.getPaymentSplitState();
            if (!plan?.active) {
                return;
            }
            if (this.pos.paymentTerminalInProgress) {
                return;
            }
            void this._onPaymentSplitFinished(line);
        };
    },

    /**
     * Core POS auto-adds a line on mount when there is a single payment method.
     * Do not open the split dialog for that call — only for explicit method clicks.
     * After a partial split payment, auto-add a line for the remaining due using the
     * same payment method as the last slice and auto-send to the terminal when applicable.
     */
    onMounted() {
        this._posPaymentSplitSuppressDialog = true;
        const order = this.currentOrder;

        for (const payment of order.payment_ids) {
            const pmid = payment.payment_method_id.id;
            if (!this.pos.config.payment_method_ids.map((pm) => pm.id).includes(pmid)) {
                payment.delete({ backend: true });
            }
        }

        const continuingPartial = Boolean(order.uiState?._posPaymentSplitContinue);
        order.uiState._posPaymentSplitContinue = false;
        if (continuingPartial) {
            order.uiState._posPaymentSplitDeclinedRemainingLine = false;
        }

        if (continuingPartial) {
            void this._posPaymentSplitAddRemainingLineIfNeeded();
        } else if (
            this.payment_methods_from_config.length === 1 &&
            this.paymentLines.length === 0
        ) {
            const paymentMethod = this.payment_methods_from_config[0];
            if (!paymentMethod.use_payment_terminal) {
                void this.addNewPaymentLine(paymentMethod);
            }
        }

        this._posPaymentSplitSuppressDialog = false;
    },

    _posPaymentSplitContinuePaymentMethod() {
        const order = this.currentOrder;
        const storedId = order.uiState?._posPaymentSplitContinuePaymentMethodId;
        if (storedId) {
            const stored = this.payment_methods_from_config.find((pm) => pm.id === storedId);
            if (stored) {
                return stored;
            }
        }
        const lastDone = [...order.payment_ids]
            .reverse()
            .find((line) => line.is_done() && line.get_amount() > 0);
        if (lastDone) {
            const method = this.payment_methods_from_config.find(
                (pm) => pm.id === lastDone.payment_method_id.id
            );
            if (method) {
                return method;
            }
        }
        return this.payment_methods_from_config[0] || null;
    },

    _posPaymentSplitIsEditableOpenLine(line, paymentMethod) {
        if (!line || line.payment_method_id.id !== paymentMethod.id) {
            return false;
        }
        const status = line.get_payment_status();
        if (!status) {
            return !line.is_electronic();
        }
        return ["pending", "retry"].includes(status);
    },

    _posPaymentSplitHasInProgressPaymentLine() {
        return this.currentOrder.payment_ids.some((line) => {
            const status = line.get_payment_status();
            return status && !["done", "reversed"].includes(status);
        });
    },

    _posPaymentSplitIsRemovableDraftLine(line) {
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
        return !status || ["pending", "retry"].includes(status);
    },

    _posPaymentSplitShouldAutoSendTerminalPayment(paymentMethod, line) {
        if (!paymentMethod?.use_payment_terminal || !line) {
            return false;
        }
        if (!(paymentMethod.payment_terminal?.fast_payments ?? true)) {
            return false;
        }
        if (this.pos.paymentTerminalInProgress) {
            return false;
        }
        const status = line.get_payment_status();
        return !status || ["pending", "retry"].includes(status);
    },

    _posPaymentSplitRestorePlan(order) {
        return order.getPaymentSplitState?.() || null;
    },

    async _posPaymentSplitAddRemainingLineIfNeeded() {
        const order = this.currentOrder;
        if (order.uiState._posPaymentSplitDeclinedRemainingLine) {
            return false;
        }
        const due = roundPaymentAmount(order.get_due(), this.pos.currency);
        if (due <= 0 || this._posPaymentSplitHasInProgressPaymentLine()) {
            return false;
        }
        if (order.payment_ids.some((line) => this._posPaymentSplitIsRemovableDraftLine(line))) {
            return false;
        }

        const plan = this._posPaymentSplitRestorePlan(order);
        if (plan?.active && plan.index < plan.count && !plan.stopRequested) {
            const paymentMethod = this.payment_methods_from_config.find(
                (pm) => pm.id === plan.paymentMethodId
            );
            if (!paymentMethod) {
                order.clearPaymentSplitState();
                return false;
            }
            plan.status = "idle";
            return this._advancePaymentSplit();
        }

        const paymentMethod = this._posPaymentSplitContinuePaymentMethod();
        if (!paymentMethod) {
            return false;
        }

        const amountDue = getPaymentSplitChargeAmount(order, plan, this.pos.currency, {
            paymentMethod,
        });

        let line = order.payment_ids.find((paymentLine) =>
            this._posPaymentSplitIsEditableOpenLine(paymentLine, paymentMethod)
        );

        if (line) {
            line.set_amount(amountDue);
        } else {
            line = order.add_paymentline(paymentMethod);
            if (!line || !this.check_cash_rounding_has_been_well_applied()) {
                return false;
            }
            line.set_amount(amountDue);
        }

        order.select_paymentline(line);
        this.numberBuffer.reset();

        if (this._posPaymentSplitShouldAutoSendTerminalPayment(paymentMethod, line)) {
            this._posPaymentSplitContinueAutoSend = true;
            try {
                await this.sendPaymentRequest(line);
            } catch (error) {
                this._posPaymentSplitContinueAutoSend = false;
                console.warn("Continue payment terminal request failed", error);
            }
        }
        return true;
    },

    _posPaymentSplitRememberContinuePaymentMethod() {
        const order = this.currentOrder;
        const lastDone = [...order.payment_ids]
            .reverse()
            .find((line) => line.is_done() && line.get_amount() > 0);
        if (lastDone) {
            order.uiState._posPaymentSplitContinuePaymentMethodId =
                lastDone.payment_method_id.id;
        }
    },

    _posPaymentSplitEnsureFullPaymentLineAmount(paymentMethod) {
        const order = this.currentOrder;
        const line = this.paymentLines.at(-1);
        if (!line || line.payment_method_id.id !== paymentMethod.id) {
            return;
        }
        const expected = order.getDefaultAmountDueToPayIn(paymentMethod);
        if (expected > 0 && line.get_amount() <= 0) {
            line.set_amount(expected);
        }
    },

    updateSelectedPaymentline(amount = false) {
        if (!this.pos.config.enable_payment_split) {
            return super.updateSelectedPaymentline(...arguments);
        }
        if (this._posPaymentSplitDialogSubmit) {
            return;
        }

        const order = this.currentOrder;

        if (!this.selectedPaymentLine) {
            return;
        }
        if (amount === false) {
            if (this.numberBuffer.get() === null) {
                amount = null;
            } else if (this.numberBuffer.get() === "") {
                amount = 0;
            } else {
                amount = this.numberBuffer.getFloat();
            }
        }
        if (
            amount === 0 &&
            this._posPaymentSplitIsRemovableDraftLine(this.selectedPaymentLine)
        ) {
            amount = null;
        }
        const payment_terminal = this.selectedPaymentLine.payment_method_id.payment_terminal;
        const hasCashPaymentMethod = this.payment_methods_from_config.some(
            (method) => method.type === "cash"
        );
        if (
            !hasCashPaymentMethod &&
            amount > order.get_due() + this.selectedPaymentLine.amount
        ) {
            this.selectedPaymentLine.set_amount(0);
            this.numberBuffer.set(order.get_due().toString());
            amount = order.get_due();
            this.showMaxValueError();
        }
        if (
            payment_terminal &&
            !["pending", "retry"].includes(this.selectedPaymentLine.get_payment_status())
        ) {
            return;
        }
        if (amount === null) {
            this.deletePaymentLine(this.selectedPaymentLine.uuid);
        } else {
            this.selectedPaymentLine.set_amount(amount);
        }
    },

    deletePaymentLine(uuid) {
        const line = this.paymentLines.find((paymentLine) => paymentLine.uuid === uuid);
        if (line && this._posPaymentSplitIsRemovableDraftLine(line)) {
            this.currentOrder.uiState._posPaymentSplitDeclinedRemainingLine = true;
        }
        return super.deletePaymentLine(...arguments);
    },

    async addNewPaymentLine(paymentMethod) {
        if (
            !this.pos.config.enable_payment_split ||
            this._posPaymentSplitSuppressDialog
        ) {
            return super.addNewPaymentLine(...arguments);
        }
        this.currentOrder.uiState._posPaymentSplitDeclinedRemainingLine = false;
        return this.posPaymentSplitAddNewPaymentLine(paymentMethod, () =>
            super.addNewPaymentLine(...arguments)
        );
    },

    /**
     * @param {Function} payFullAmountLine calls core/terminal addNewPaymentLine
     */
    async posPaymentSplitAddNewPaymentLine(paymentMethod, payFullAmountLine) {
        const order = this.currentOrder;

        if (order.isPaymentSplitActive()) {
            return this._continuePaymentSplit(paymentMethod);
        }

        const due = roundPaymentAmount(order.get_due(), this.pos.currency);
        if (due <= 0) {
            return payFullAmountLine();
        }

        if (this.pos.paymentTerminalInProgress && paymentMethod.use_payment_terminal) {
            this.dialog.add(AlertDialog, {
                title: _t("Error"),
                body: _t("There is already an electronic payment in progress."),
            });
            return false;
        }

        return this._openSplitPaymentDialog(paymentMethod, due, payFullAmountLine);
    },

    _openSplitPaymentDialog(paymentMethod, due, payFullAmountLine) {
        return new Promise((resolve) => {
            this.dialog.add(SplitPaymentDialog, {
                due,
                currency: this.pos.currency,
                formatCurrency: (amount) => this.env.utils.formatCurrency(amount),
                paymentMethodName: paymentMethod.name,
                confirmSplit: async (config) => {
                    this._posPaymentSplitDialogSubmit = true;
                    if (config.mode === SPLIT_MODES.FULL) {
                        const order = this.currentOrder;
                        if (paymentMethod.use_payment_terminal) {
                            order.setPaymentSplitState({
                                active: true,
                                mode: SPLIT_MODES.FULL,
                                splitValue: due,
                                count: 1,
                                amounts: [due],
                                index: 0,
                                lastCompletedIndex: -1,
                                initialDue: due,
                                paymentMethodId: paymentMethod.id,
                                status: "idle",
                                pendingAmount: null,
                                stopRequested: false,
                            });
                        }
                        const ok = await payFullAmountLine();
                        if (ok !== false) {
                            this._posPaymentSplitEnsureFullPaymentLineAmount(paymentMethod);
                            if (!paymentMethod.use_payment_terminal) {
                                await this._posPaymentSplitAfterDialogSubmit();
                            }
                        } else {
                            this._posPaymentSplitDialogSubmit = false;
                            if (paymentMethod.use_payment_terminal) {
                                order.clearPaymentSplitState();
                            }
                        }
                        resolve(ok !== false);
                        return;
                    }
                    const started = await this._startPaymentSplit(paymentMethod, config, due);
                    resolve(started);
                },
                close: () => resolve(false),
            });
        });
    },

    async _startPaymentSplit(paymentMethod, config, due) {
        const order = this.currentOrder;
        const amounts = computeSplitAmounts(
            due,
            config.mode,
            config.value,
            this.pos.currency
        );

        if (!amounts.length) {
            let body = _t(
                "Could not build a payment plan. Check the amount, percentage, or number of parts."
            );
            if (config.mode === SPLIT_MODES.PARTS) {
                const maxParts = maxEqualSplitParts(due, this.pos.currency);
                const minUnit = this.env.utils.formatCurrency(this.pos.currency.rounding ?? 0.01);
                body = _t(
                    "Cannot split %(total)s into %(parts)s equal payments. Each payment must be at least %(minUnit)s, so the maximum for this order is %(maxParts)s payments.",
                    {
                        total: this.env.utils.formatCurrency(due),
                        parts: String(Math.floor(config.value)),
                        minUnit,
                        maxParts: String(maxParts),
                    }
                );
            }
            this.dialog.add(AlertDialog, {
                title: _t("Invalid split"),
                body,
            });
            return false;
        }

        order.setPaymentSplitState({
            active: true,
            mode: config.mode,
            splitValue: config.value,
            count: amounts.length,
            amounts,
            index: 0,
            lastCompletedIndex: -1,
            initialDue: due,
            paymentMethodId: paymentMethod.id,
            status: "idle",
            pendingAmount: null,
            stopRequested: false,
        });

        return this._advancePaymentSplit();
    },

    async _continuePaymentSplit(paymentMethod) {
        const order = this.currentOrder;
        const plan = order.getPaymentSplitState();
        if (!plan?.active) {
            return false;
        }

        if (plan.status === "stopped") {
            plan.paymentMethodId = paymentMethod.id;
            return this._retryPaymentSplit();
        }

        if (plan.index < plan.count && plan.status === "idle") {
            plan.paymentMethodId = paymentMethod.id;
            return this._advancePaymentSplit();
        }

        return false;
    },

    _findSplitPendingLine(order, plan) {
        return order.payment_ids.find(
            (line) =>
                line.payment_method_id.id === plan.paymentMethodId &&
                !line.is_done() &&
                ["waitingCard", "waiting", "waitingCancel", "retry", "pending"].includes(
                    line.get_payment_status()
                )
        );
    },

    async _advancePaymentSplit() {
        const order = this.currentOrder;
        const plan = order.getPaymentSplitState();
        if (!plan?.active || plan.stopRequested) {
            return false;
        }

        if (plan.index >= plan.count) {
            plan.status = "completed";
            order.clearPaymentSplitState();
            return true;
        }

        const due = roundPaymentAmount(order.get_due(), this.pos.currency);
        if (due <= 0) {
            plan.status = "completed";
            order.clearPaymentSplitState();
            return true;
        }

        const paymentMethod = this.payment_methods_from_config.find(
            (pm) => pm.id === plan.paymentMethodId
        );
        if (!paymentMethod) {
            order.clearPaymentSplitState();
            return false;
        }

        if (this.pos.paymentTerminalInProgress) {
            this.dialog.add(AlertDialog, {
                title: _t("Error"),
                body: _t("There is already an electronic payment in progress."),
            });
            return false;
        }

        const amount = getPaymentSplitChargeAmount(order, plan, this.pos.currency, {
            paymentMethod,
        });
        if (amount <= 0) {
            plan.index += 1;
            return this._advancePaymentSplit();
        }

        plan.pendingAmount = amount;
        plan.status = "in_progress";
        plan._lastFinishedLineUuid = null;

        const line = order.add_paymentline(paymentMethod);
        if (!this.check_cash_rounding_has_been_well_applied()) {
            order.clearPaymentSplitState();
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

        if (
            paymentMethod.use_payment_terminal &&
            (paymentMethod.payment_terminal?.fast_payments ?? true)
        ) {
            plan.status = "waiting_terminal";
            await this.sendPaymentRequest(line);
        } else {
            await this._onPaymentSplitFinished(line);
        }
        return true;
    },

    _posPaymentSplitMarkCashLinesDone() {
        for (const line of this.currentOrder.payment_ids) {
            if (
                !line.payment_method_id.use_payment_terminal &&
                line.get_amount() > 0 &&
                !line.get_payment_status()
            ) {
                line.set_payment_status("done");
            }
        }
    },

    /**
     * After dialog submit: full validate when paid, otherwise print receipt and
     * return to continue collecting (same idea as restaurant split-bill flow).
     */
    async _posPaymentSplitAfterDialogSubmit({ keepSplitPlan = false } = {}) {
        this._posPaymentSplitDialogSubmit = false;
        const order = this.currentOrder;

        this._posPaymentSplitMarkCashLinesDone();

        if (order.is_paid()) {
            order.uiState._posPaymentSplitContinuePaymentMethodId = undefined;
            order.clearPaymentSplitState();
            await this.validateOrder(false);
            return;
        }

        if (!keepSplitPlan && !order.isPaymentSplitActive()) {
            order.clearPaymentSplitState();
        }

        this._posPaymentSplitRememberContinuePaymentMethod();
        order.recomputeOrderData();
        this.pos.addPendingOrder([order.id]);
        try {
            await this.pos.syncAllOrders({ orders: [order] });
        } catch (error) {
            console.warn("Payment split slice sync failed or offline", error);
        }

        if (this.pos.config.iface_print_auto) {
            await this.pos.printReceipt({ order });
        }

        order.set_screen_data({ name: "ReceiptScreen" });
        this.pos.showScreen("ReceiptScreen");
    },

    async sendPaymentRequest(line) {
        const order = this.currentOrder;
        const plan = this._posPaymentSplitRestorePlan(order);
        const isSplit =
            plan?.active && line.payment_method_id.id === plan.paymentMethodId;

        if (isSplit) {
            plan.status = "waiting_terminal";
        }

        this.pos._posPaymentSplitHandlingTerminalRequest = true;
        try {
            await super.sendPaymentRequest(line);
        } finally {
            this.pos._posPaymentSplitHandlingTerminalRequest = false;
        }

        if (isSplit) {
            if (plan.stopRequested || plan.status === "stopped") {
                return;
            }
            await this._onPaymentSplitFinished(line);
            return;
        }

        if (line.is_done()) {
            if (this._posPaymentSplitDialogSubmit) {
                await this._posPaymentSplitAfterDialogSubmit();
            } else if (this._posPaymentSplitContinueAutoSend) {
                this._posPaymentSplitContinueAutoSend = false;
                await this._posPaymentSplitAfterDialogSubmit();
            }
        } else if (this._posPaymentSplitContinueAutoSend) {
            this._posPaymentSplitContinueAutoSend = false;
        }
    },

    async _onPaymentSplitFinished(line) {
        const order = this.currentOrder;
        const plan = this._posPaymentSplitRestorePlan(order);
        if (!plan?.active || plan._finishingSlice) {
            return;
        }

        if (!line.is_done()) {
            if (line.get_payment_status() === "retry") {
                plan.status = "stopped";
            }
            return;
        }

        if (plan._lastFinishedLineUuid === line.uuid) {
            return;
        }
        if (plan.lastCompletedIndex >= plan.index) {
            return;
        }

        plan._finishingSlice = true;
        try {
            plan._lastFinishedLineUuid = line.uuid;
            plan.lastCompletedIndex = plan.index;
            plan.index += 1;
            plan.status = "idle";
            plan.pendingAmount = null;

            const due = roundPaymentAmount(order.get_due(), this.pos.currency);
            const moreSlicesRemaining =
                plan.index < plan.count && due > 0 && !plan.stopRequested;

            if (!moreSlicesRemaining) {
                plan.status = "completed";
                order.clearPaymentSplitState();
                await this._posPaymentSplitAfterDialogSubmit();
                return;
            }

            await this._posPaymentSplitAfterDialogSubmit({ keepSplitPlan: true });
        } finally {
            if (plan?.active) {
                plan._finishingSlice = false;
            }
        }
    },

    async sendPaymentCancel(line) {
        const order = this.currentOrder;
        const plan = order.getPaymentSplitState();
        const hadSplit = plan?.active;
        await super.sendPaymentCancel(line);
        if (hadSplit && ["waiting_terminal", "in_progress", "idle"].includes(plan.status)) {
            plan.stopRequested = true;
            plan.status = "stopped";
            this.pos.paymentTerminalInProgress = false;
        }
    },

    cancelPaymentSplit() {
        const order = this.currentOrder;
        const plan = order.getPaymentSplitState();
        if (!plan) {
            return;
        }
        const pending = order.payment_ids.filter(
            (line) =>
                line.payment_method_id.id === plan.paymentMethodId && !line.is_done()
        );
        for (const line of pending) {
            order.remove_paymentline(line);
        }
        order.clearPaymentSplitState();
        this.pos.paymentTerminalInProgress = false;
        this.numberBuffer.reset();
    },

    _findAnyTerminalPendingLine(order) {
        return order.payment_ids.find(
            (line) =>
                line.payment_method_id.use_payment_terminal &&
                !line.is_done() &&
                ["waitingCard", "waiting", "waitingCancel", "retry", "pending"].includes(
                    line.get_payment_status()
                )
        );
    },

    async stopPaymentSplit() {
        const order = this.currentOrder;
        const plan = order.getPaymentSplitState();
        if (!plan?.active) {
            const pendingLine = this._findAnyTerminalPendingLine(order);
            if (pendingLine) {
                if (pendingLine.get_payment_status() === "waitingCard") {
                    await this.sendPaymentCancel(pendingLine);
                } else if (pendingLine.payment_method_id.payment_terminal) {
                    await pendingLine.payment_method_id.payment_terminal.send_payment_cancel(
                        order,
                        pendingLine.uuid
                    );
                    pendingLine.set_payment_status("retry");
                    this.pos.paymentTerminalInProgress = false;
                } else {
                    this.pos.paymentTerminalInProgress = false;
                }
            } else {
                this.pos.paymentTerminalInProgress = false;
            }
            return;
        }
        plan.stopRequested = true;
        plan.status = "stopped";

        const pendingLine = this._findSplitPendingLine(order, plan);
        if (pendingLine) {
            if (pendingLine.get_payment_status() === "waitingCard") {
                await this.sendPaymentCancel(pendingLine);
            } else if (pendingLine.payment_method_id.payment_terminal) {
                await pendingLine.payment_method_id.payment_terminal.send_payment_cancel(
                    order,
                    pendingLine.uuid
                );
                pendingLine.set_payment_status("retry");
                this.pos.paymentTerminalInProgress = false;
            }
        } else {
            this.pos.paymentTerminalInProgress = false;
        }
    },

    async retryPaymentSplit() {
        const order = this.currentOrder;
        const plan = order.getPaymentSplitState();
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
            const paymentMethod = this.payment_methods_from_config.find(
                (pm) => pm.id === plan.paymentMethodId
            );
            const amount = getPaymentSplitChargeAmount(order, plan, this.pos.currency, {
                paymentMethod,
            });
            plan.pendingAmount = amount;
            retryLine.set_amount(amount);
            await this.sendPaymentRequest(retryLine);
            return;
        }

        plan.status = "idle";
        await this._advancePaymentSplit();
    },

    get paymentSplitPlan() {
        return this.currentOrder.getPaymentSplitState() || null;
    },

    get paymentSplitBusy() {
        return Boolean(this.pos.paymentTerminalInProgress);
    },

    formatSplitCurrency(amount) {
        return this.env.utils.formatCurrency(amount);
    },

    async sendForceDone(line) {
        if (!this.pos.config.allow_terminal_force_done) {
            return;
        }
        if (line.payment_method_id?.use_payment_terminal) {
            const authorized = await requireTerminalManagerApproval(this.pos, this.dialog);
            if (!authorized) {
                return;
            }
            const iface = line.payment_method_id.payment_terminal;
            if (iface?.forceCompleteLine) {
                iface.forceCompleteLine(line);
                return;
            }
        }
        return super.sendForceDone(...arguments);
    },
});

PaymentScreen.components = {
    ...PaymentScreen.components,
    SplitPaymentStatus,
};
