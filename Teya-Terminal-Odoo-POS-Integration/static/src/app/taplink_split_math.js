/** @odoo-module */

import { roundPrecision } from "@web/core/utils/numbers";
import {
    amountToMinorUnits,
    computeEqualSplitAmounts,
    getPaymentSplitChargeAmount,
} from "@pos_payment_split/app/split_payment_math";

/**
 * Round a POS monetary amount using the order currency.
 * @param {number} amount
 * @param {object} currency pos.currency
 * @returns {number}
 */
export function roundPaymentAmount(amount, currency) {
    const rounding = currency?.rounding ?? 0.01;
    return roundPrecision(amount, rounding);
}

export { amountToMinorUnits, computeEqualSplitAmounts };

/**
 * Amount to charge on the terminal for the current equal-split step.
 * @param {import('@point_of_sale/app/models/pos_order').PosOrder} order
 * @param {object|null} plan taplink equal split state
 * @param {object} currency pos.currency
 * @returns {number}
 */
export function getTaplinkSplitChargeAmount(order, plan, currency, paymentMethod = null) {
    if (!plan?.active) {
        return roundPaymentAmount(order.get_due(), currency);
    }
    return getPaymentSplitChargeAmount(order, plan, currency, { paymentMethod });
}

/**
 * Resolve the amount to send to Teya for a payment line (split or full pay).
 * @param {import('@point_of_sale/app/models/pos_order').PosOrder} order
 * @param {import('@point_of_sale/app/models/pos_payment').PosPayment} line
 * @param {object} currency pos.currency
 * @returns {number}
 */
function resolveActiveSplitPlan(order) {
    if (typeof order.getPaymentSplitState === "function") {
        const paymentSplitPlan = order.getPaymentSplitState();
        if (paymentSplitPlan?.active) {
            return paymentSplitPlan;
        }
    }
    return order.getTaplinkEqualSplitState?.();
}

export function getTaplinkTerminalChargeAmount(order, line, currency) {
    const plan = resolveActiveSplitPlan(order);
    if (plan?.active) {
        return getTaplinkSplitChargeAmount(order, plan, currency, line?.payment_method_id);
    }
    const due = roundPaymentAmount(order.get_due(), currency);
    if (due > 0) {
        return due;
    }
    return roundPaymentAmount(line.amount, currency);
}

export function listTaplinkPaymentMethods(paymentMethods) {
    return paymentMethods.filter((pm) => pm.use_payment_terminal === "taplink");
}
