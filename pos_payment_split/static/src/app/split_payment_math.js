/** @odoo-module */

import { roundPrecision } from "@web/core/utils/numbers";

export const SPLIT_MODES = {
    FULL: "full",
    AMOUNT: "amount",
    PERCENTAGE: "percentage",
    PARTS: "parts",
};

const MAX_SPLIT_PAYMENTS = 50;
const MIN_PARTS = 2;
const MAX_PARTS = 20;

/**
 * @param {number} amount
 * @param {object} currency
 * @returns {number}
 */
export function roundPaymentAmount(amount, currency) {
    const rounding = currency?.rounding ?? 0.01;
    return roundPrecision(amount, rounding);
}

/**
 * @param {number} amount
 * @param {object} currency
 * @returns {number}
 */
export function amountToMinorUnits(amount, currency) {
    const rounding = currency?.rounding ?? 0.01;
    return Math.round(roundPaymentAmount(amount, currency) / rounding);
}

/**
 * @param {number} minor
 * @param {object} currency
 * @returns {number}
 */
export function minorUnitsToAmount(minor, currency) {
    const rounding = currency?.rounding ?? 0.01;
    return roundPrecision(minor * rounding, rounding);
}

/**
 * Maximum equal parts when each part must be at least one currency unit (e.g. 1p).
 * @param {number} total
 * @param {object} currency
 * @returns {number}
 */
export function maxEqualSplitParts(total, currency) {
    return amountToMinorUnits(total, currency);
}

/**
 * @param {number} total
 * @param {number} count
 * @param {object} currency
 * @returns {boolean}
 */
export function isValidEqualSplit(total, count, currency) {
    const parts = Math.floor(count);
    return (
        parts >= MIN_PARTS &&
        parts <= MAX_PARTS &&
        parts <= maxEqualSplitParts(total, currency)
    );
}

/**
 * Split `total` into `count` equal parts using minor units (no float drift).
 * Remainder pence are distributed across the first slices (e.g. 10p / 3 → 4p+3p+3p).
 * @param {number} total
 * @param {number} count
 * @param {object} currency
 * @returns {number[]}
 */
export function computeEqualSplitAmounts(total, count, currency) {
    const totalMinor = amountToMinorUnits(total, currency);
    const parts = Math.floor(count);
    if (totalMinor <= 0 || !isValidEqualSplit(total, parts, currency)) {
        return [];
    }
    const baseMinor = Math.floor(totalMinor / parts);
    const extra = totalMinor % parts;
    const amounts = [];
    for (let i = 0; i < parts; i++) {
        const minor = baseMinor + (i < extra ? 1 : 0);
        if (minor > 0) {
            amounts.push(minorUnitsToAmount(minor, currency));
        }
    }
    return amounts;
}

/**
 * Build payment chunks for the current split action.
 * Amount / percentage: one payment only; leftover stays as order due.
 * Parts: equal split of full due into N payments.
 *
 * @param {number} totalDue
 * @param {'amount'|'percentage'|'parts'} mode
 * @param {number} value amount per payment, percent (1–100), or number of parts
 * @param {object} currency
 * @returns {number[]}
 */
export function computeSplitAmounts(totalDue, mode, value, currency) {
    const due = roundPaymentAmount(totalDue, currency);
    if (due <= 0 || value <= 0) {
        return [];
    }

    if (mode === SPLIT_MODES.PARTS) {
        return _computePartsSplit(due, value, currency);
    }
    if (mode === SPLIT_MODES.PERCENTAGE) {
        return _computePercentageSplit(due, value, currency);
    }
    return _computeAmountSplit(due, value, currency);
}

function _computeAmountSplit(_due, amountPerPayment, currency) {
    const chunk = roundPaymentAmount(amountPerPayment, currency);
    return chunk > 0 ? [chunk] : [];
}

function _computePercentageSplit(due, percent, currency) {
    const pct = Math.min(100, Math.max(0, percent)) / 100;
    let chunk = roundPaymentAmount(due * pct, currency);
    if (chunk <= 0) {
        return [];
    }
    if (chunk > due) {
        chunk = due;
    }
    return [chunk];
}

function _computePartsSplit(due, partCount, currency) {
    const count = Math.min(MAX_PARTS, Math.max(MIN_PARTS, Math.floor(partCount)));
    if (count < MIN_PARTS) {
        return [];
    }
    return computeEqualSplitAmounts(due, Math.min(count, MAX_SPLIT_PAYMENTS), currency);
}

/**
 * @param {import('@point_of_sale/app/models/pos_order').PosOrder} order
 * @param {object|null} plan
 * @param {object} currency
 * @param {{ paymentMethod?: object }} [options]
 * @returns {number}
 */
export function getPaymentSplitChargeAmount(order, plan, currency, options = {}) {
    if (!plan?.active) {
        return roundPaymentAmount(order.get_due(), currency);
    }
    const due = roundPaymentAmount(order.get_due(), currency);
    const sliceIndex = Math.min(Math.max(plan.index, 0), (plan.amounts?.length || 1) - 1);
    const planned = plan.amounts?.[sliceIndex];
    if (planned != null && planned > 0) {
        let charge = roundPaymentAmount(planned, currency);
        // Card terminals cannot be over-charged; cash may exceed due to give change.
        if (options.paymentMethod?.use_payment_terminal && charge > due) {
            charge = due;
        }
        return charge;
    }
    if (plan.pendingAmount != null && plan.pendingAmount > 0) {
        let charge = roundPaymentAmount(plan.pendingAmount, currency);
        if (options.paymentMethod?.use_payment_terminal && charge > due) {
            charge = due;
        }
        return charge;
    }
    return due;
}

/**
 * @param {'amount'|'percentage'|'parts'} mode
 * @param {number} value
 * @param {number} due
 * @param {object} currency
 * @returns {{
 *   paymentCount: number,
 *   firstAmount: number,
 *   perPartAmount: number,
 *   totalCovered: number,
 *   remainingAfter: number,
 *   changeAmount: number,
 * }}
 */
export function previewSplitPlan(mode, value, due, currency) {
    const amounts = computeSplitAmounts(due, mode, value, currency);
    const totalCovered = amounts.reduce((sum, a) => sum + a, 0);
    const dueRounded = roundPaymentAmount(due, currency);
    const coveredRounded = roundPaymentAmount(totalCovered, currency);
    return {
        paymentCount: amounts.length,
        firstAmount: amounts[0] ?? 0,
        perPartAmount: amounts[0] ?? 0,
        totalCovered: coveredRounded,
        remainingAfter: roundPaymentAmount(Math.max(0, dueRounded - coveredRounded), currency),
        changeAmount:
            coveredRounded > dueRounded
                ? roundPaymentAmount(coveredRounded - dueRounded, currency)
                : 0,
    };
}
