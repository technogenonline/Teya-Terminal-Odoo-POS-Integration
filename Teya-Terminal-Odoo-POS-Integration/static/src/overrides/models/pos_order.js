import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { patch } from "@web/core/utils/patch";

patch(PosOrder.prototype, {
    setup() {
        super.setup(...arguments);
        this.taplink_gateway_ref ??= "";
        this.taplink_tx_ref ??= "";
        this.taplink_gateway_payload ??= "";
        this.taplink_equal_split_state = null;
    },

    storeTaplinkGatewayPayload(response) {
        this.taplink_gateway_ref = response.gateway_payment_id;
        this.taplink_tx_ref = response.transaction_id;
        this.taplink_gateway_payload = response;
    },

    /** Active split plan: pos_payment_split dialog or legacy Teya equal-split panel. */
    _getActiveSplitPlan() {
        if (typeof this.getPaymentSplitState === "function") {
            const paymentSplitPlan = this.getPaymentSplitState();
            if (paymentSplitPlan?.active) {
                return paymentSplitPlan;
            }
        } else if (this.payment_split_state?.active) {
            return this.payment_split_state;
        }
        return this.taplink_equal_split_state;
    },

    getTaplinkEqualSplitState() {
        return this._getActiveSplitPlan();
    },

    setTaplinkEqualSplitState(plan) {
        if (plan?.mode != null) {
            if (typeof this.setPaymentSplitState === "function") {
                this.setPaymentSplitState(plan);
            } else {
                this.payment_split_state = plan;
            }
            return;
        }
        this.taplink_equal_split_state = plan;
    },

    clearTaplinkEqualSplitState() {
        this.taplink_equal_split_state = null;
        if (typeof this.clearPaymentSplitState === "function") {
            this.clearPaymentSplitState();
        }
    },

    isTaplinkEqualSplitActive() {
        return Boolean(this._getActiveSplitPlan()?.active);
    },

    serialize() {
        const data = super.serialize(...arguments);
        data.taplink_gateway_ref = this.taplink_gateway_ref || "";
        data.taplink_tx_ref = this.taplink_tx_ref || "";
        if (this.taplink_gateway_payload === undefined || this.taplink_gateway_payload === "") {
            data.taplink_gateway_payload = "";
        } else if (typeof this.taplink_gateway_payload === "string") {
            data.taplink_gateway_payload = this.taplink_gateway_payload;
        } else {
            data.taplink_gateway_payload = JSON.stringify(this.taplink_gateway_payload);
        }
        return data;
    },

    add_paymentline(payment_method) {
        const res = super.add_paymentline(...arguments);
        if (!res) {
            return res;
        }
        const plan = this._getActiveSplitPlan();
        if (plan?.active && plan.pendingAmount != null) {
            res.set_amount(plan.pendingAmount);
            plan.pendingAmount = null;
            return res;
        }
        if (this?.taplink_gateway_payload && !plan?.active) {
            this.get_selected_paymentline()?.set_amount(-this.get_due());
        }
        return res;
    },
});
