/** @odoo-module */

import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { patch } from "@web/core/utils/patch";

patch(PosOrder.prototype, {
    setup() {
        super.setup(...arguments);
        this.payment_split_state = null;
        if (this.uiState?.payment_split_state?.active) {
            this.payment_split_state = this.uiState.payment_split_state;
        }
    },

    getPaymentSplitState() {
        if (!this.payment_split_state?.active && this.uiState?.payment_split_state?.active) {
            this.payment_split_state = this.uiState.payment_split_state;
        }
        return this.payment_split_state;
    },

    setPaymentSplitState(plan) {
        this.payment_split_state = plan;
        if (!this.uiState) {
            this.uiState = {};
        }
        this.uiState.payment_split_state = plan;
    },

    clearPaymentSplitState() {
        this.payment_split_state = null;
        if (this.uiState) {
            this.uiState.payment_split_state = null;
        }
    },

    isPaymentSplitActive() {
        return Boolean(this.getPaymentSplitState()?.active);
    },

    /** Aliases for Teya terminal module compatibility */
    getTaplinkEqualSplitState() {
        return this.getPaymentSplitState();
    },

    setTaplinkEqualSplitState(plan) {
        this.setPaymentSplitState(plan);
    },

    clearTaplinkEqualSplitState() {
        this.clearPaymentSplitState();
    },

    isTaplinkEqualSplitActive() {
        return this.isPaymentSplitActive();
    },

    add_paymentline(payment_method) {
        const res = super.add_paymentline(...arguments);
        if (!res) {
            return res;
        }
        const plan = this.getPaymentSplitState();
        if (plan?.active && plan.pendingAmount != null) {
            res.set_amount(plan.pendingAmount);
            plan.pendingAmount = null;
        }
        return res;
    },
});
